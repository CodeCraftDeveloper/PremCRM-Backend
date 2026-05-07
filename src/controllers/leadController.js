import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import { Lead, Website, LeadActivity } from "../models/index.js";
import AuditLog from "../models/AuditLog.js";
import UsageMetric from "../models/UsageMetric.js";
import LeadService from "../core/leads/LeadService.js";
import DuplicateDetectionService from "../core/leads/DuplicateDetectionService.js";
import AssignmentService from "../core/leads/AssignmentService.js";
import { uploadToS3, deleteFromS3 } from "../config/s3.js";
import { emitCrmEvent } from "../services/workflow/index.js";
import logger from "../utils/logger.js";
import fs from "fs";
import path from "path";

/**
 * @desc    Get all leads for tenant
 * @route   GET /api/leads
 * @access  Private
 */
const getLeads = asyncHandler(async (req, res, next) => {
  try {
    const {
      status,
      websiteId,
      assignedTo,
      source,
      unassigned,
      page = 1,
      limit = 20,
      search,
    } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (websiteId) filters.websiteId = websiteId;
    if (assignedTo !== undefined) filters.assignedTo = assignedTo;
    if (source) filters.source = source;
    if (unassigned) filters.unassigned = unassigned === "true";
    if (search) filters.search = search;

    const result = await LeadService.getLeads(
      req.user.tenantId,
      filters,
      parseInt(page),
      parseInt(limit),
    );

    successResponse(res, result, "Leads retrieved successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get lead details
 * @route   GET /api/leads/:id
 * @access  Private
 */
const getLeadDetail = asyncHandler(async (req, res, next) => {
  try {
    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    })
      .populate("assignedTo", "name email")
      .populate("websiteId", "name domain")
      .populate("duplicateOf", "fullName email source");

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Get activity history — scoped by tenantId to prevent cross-tenant leak
    const activities = await LeadActivity.find({
      leadId: req.params.id,
      tenantId: req.user.tenantId,
    })
      .populate("performedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(20);

    successResponse(res, { lead, activities }, "Lead details retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Manual lead creation (admin)
 * @route   POST /api/leads
 * @access  Private (admin/marketing)
 */
const createLeadManual = asyncHandler(async (req, res, next) => {
  try {
    let { firstName, email, websiteId, fullName, ...otherData } = req.body;

    // CRM contract adapter: split fullName → firstName/lastName if needed
    if (!firstName && fullName) {
      const parts = fullName.trim().split(/\s+/);
      firstName = parts[0] || "";
      if (!otherData.lastName && parts.length > 1) {
        otherData.lastName = parts.slice(1).join(" ");
      }
    }

    // Map CRM ownerId → legacy assignedTo
    if (otherData.ownerId && !otherData.assignedTo) {
      otherData.assignedTo = otherData.ownerId;
      delete otherData.ownerId;
    }

    if (!firstName || !email) {
      return next(ApiError.badRequest("First name and email are required"));
    }

    if (!websiteId) {
      const defaultWebsite = await Website.findOne({
        tenantId: req.user.tenantId,
        isActive: true,
      })
        .sort({ createdAt: 1 })
        .select("_id");

      if (!defaultWebsite) {
        return next(
          ApiError.badRequest(
            "Website ID is required because no active website exists for this tenant",
          ),
        );
      }

      websiteId = defaultWebsite._id;
    }

    // Verify website exists and belongs to tenant
    const website = await Website.findOne({
      _id: websiteId,
      tenantId: req.user.tenantId,
    });

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    const leadData = {
      firstName,
      email,
      ...otherData,
    };

    const result = await LeadService.createLead(
      leadData,
      websiteId,
      req.user.tenantId,
      {
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      },
    );

    // Log activity
    await LeadActivity.create({
      tenantId: req.user.tenantId,
      leadId: result.leadId,
      action: "created",
      description: `Lead manually created by ${req.user.name}`,
      performedBy: req.user._id,
    });

    // Track usage metric
    UsageMetric.increment(req.user.tenantId, "leadsCreated", 1);

    // Audit log
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "lead.create",
      entityType: "lead",
      entityId: result.leadId,
      description: `Lead manually created by ${req.user.name}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Return full lead document so the frontend can add it to the list
    const createdLead = await Lead.findById(result.leadId)
      .populate("assignedTo", "name email")
      .populate("websiteId", "name domain")
      .lean();

    // Fire CRM event bus (v1 + v2 workflows)
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "lead",
      triggerType: "on_create",
      entity: createdLead || { _id: result.leadId },
      user: req.user,
    });

    successResponse(
      res,
      { lead: createdLead || { _id: result.leadId } },
      "Lead created successfully",
      201,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update lead
 * @route   PUT /api/leads/:id
 * @access  Private
 */
const updateLead = asyncHandler(async (req, res, next) => {
  try {
    // CRM contract adapter: split fullName → firstName/lastName if needed
    if (!req.body.firstName && req.body.fullName) {
      const parts = req.body.fullName.trim().split(/\s+/);
      req.body.firstName = parts[0] || "";
      if (!req.body.lastName && parts.length > 1) {
        req.body.lastName = parts.slice(1).join(" ");
      }
      delete req.body.fullName;
    }

    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Allowed fields to update
    const allowedFields = [
      "firstName",
      "lastName",
      "phone",
      "message",
      "country",
      "city",
      "state",
      "zipCode",
      "company",
      "productInterest",
      "customFields",
      "tags",
      "notes",
      "score",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const updatedLead = await Lead.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.user.tenantId },
      updates,
      { new: true },
    );

    // Build change context for field-change triggers
    const changes = {};
    for (const [field, newVal] of Object.entries(updates)) {
      changes[field] = { old: lead[field], new: newVal };
    }

    // Fire CRM event bus (v1 + v2 workflows)
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "lead",
      triggerType: "on_update",
      entity: updatedLead?.toObject?.() || updatedLead,
      changes,
      user: req.user,
    });

    successResponse(res, updatedLead, "Lead updated successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update lead status
 * @route   PUT /api/leads/:id/status
 * @access  Private
 */
const updateLeadStatus = asyncHandler(async (req, res, next) => {
  try {
    const { status } = req.body;

    if (!status) {
      return next(ApiError.badRequest("Status is required"));
    }

    const updatedLead = await LeadService.updateLeadStatus(
      req.params.id,
      status,
      req.user.tenantId,
      req.user._id,
    );

    // Audit log for status change
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "lead.status_change",
      entityType: "lead",
      entityId: req.params.id,
      description: `Lead status changed to ${status}`,
      metadata: { newStatus: status },
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Fire CRM event bus — status is a "stage change" equivalent for leads
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "lead",
      triggerType: "on_stage_change",
      entity: updatedLead?.toObject?.() || updatedLead,
      changes: { status: { old: undefined, new: status } },
      user: req.user,
    });

    successResponse(res, updatedLead, "Lead status updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Assign lead to user
 * @route   PUT /api/leads/:id/assign
 * @access  Private (admin)
 */
const assignLead = asyncHandler(async (req, res, next) => {
  try {
    const { assignToUserId } = req.body;

    if (!assignToUserId) {
      return next(ApiError.badRequest("User ID is required"));
    }

    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    const result = await AssignmentService.assignLeadToUser(
      req.params.id,
      assignToUserId,
      req.user.tenantId,
      "manual",
    );

    successResponse(res, result, "Lead assigned successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Mark lead as duplicate
 * @route   PUT /api/leads/:id/mark-duplicate
 * @access  Private (admin)
 */
const markDuplicate = asyncHandler(async (req, res, next) => {
  try {
    const { originalLeadId } = req.body;

    if (!originalLeadId) {
      return next(ApiError.badRequest("Original lead ID is required"));
    }

    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    const updatedLead = await DuplicateDetectionService.markAsDuplicate(
      req.params.id,
      originalLeadId,
      req.user.tenantId,
    );

    // Log activity
    await LeadActivity.create({
      tenantId: req.user.tenantId,
      leadId: req.params.id,
      action: "duplicate_detected",
      description: `Marked as duplicate of ${originalLeadId}`,
      performedBy: req.user._id,
    });

    successResponse(res, updatedLead, "Lead marked as duplicate");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Merge duplicate leads
 * @route   POST /api/leads/:id/merge/:duplicateId
 * @access  Private (admin)
 */
const mergeDuplicates = asyncHandler(async (req, res, next) => {
  try {
    const { id, duplicateId } = req.params;

    const originalLead = await Lead.findOne({
      _id: id,
      tenantId: req.user.tenantId,
    });

    if (!originalLead) {
      return next(ApiError.notFound("Original lead not found"));
    }

    const mergedLead = await DuplicateDetectionService.mergeDuplicates(
      id,
      duplicateId,
      req.user.tenantId,
      req.user._id,
    );

    successResponse(res, mergedLead, "Leads merged successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get lead analytics
 * @route   GET /api/leads/analytics/dashboard
 * @access  Private
 */
const getLeadAnalytics = asyncHandler(async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const analytics = await LeadService.getLeadAnalytics(req.user.tenantId, {
      dateFrom,
      dateTo,
    });

    successResponse(res, analytics, "Analytics retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get unassigned leads count
 * @route   GET /api/leads/unassigned/count
 * @access  Private
 */
const getUnassignedCount = asyncHandler(async (req, res, next) => {
  try {
    const count = await AssignmentService.getUnassignedLeadsCount(
      req.user.tenantId,
    );

    successResponse(res, { count }, "Unassigned leads count");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Auto-assign unassigned leads
 * @route   POST /api/leads/auto-assign
 * @access  Private (admin)
 */
const autoAssignLeads = asyncHandler(async (req, res, next) => {
  try {
    const { method = "round_robin" } = req.body;

    const result = await AssignmentService.autoAssignAllUnassigned(
      req.user.tenantId,
      method,
    );

    logger.info(
      `Auto-assigned ${result.assigned} leads using ${method} by ${req.user.name}`,
    );

    successResponse(res, result, "Auto-assignment completed");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete lead
 * @route   DELETE /api/leads/:id
 * @access  Private (admin)
 */
const deleteLead = asyncHandler(async (req, res, next) => {
  try {
    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Soft delete by default (set deletedAt instead of removing)
    lead.deletedAt = new Date();
    lead.deletedBy = req.user._id;
    await lead.save();

    // Audit log
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "lead.soft_delete",
      entityType: "lead",
      entityId: lead._id,
      description: `Lead ${lead._id} soft-deleted by ${req.user.name}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    logger.info(`Lead ${req.params.id} soft-deleted by ${req.user.name}`);

    successResponse(res, null, "Lead deleted successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Upload attachments to a lead
 * @route   POST /api/leads/:id/attachments
 * @access  Private (admin/marketing)
 */
const uploadLeadAttachments = asyncHandler(async (req, res, next) => {
  try {
    const lead = await Lead.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    if (!req.files || req.files.length === 0) {
      return next(ApiError.badRequest("No files uploaded"));
    }

    // Check total attachments limit (max 10 per lead)
    if ((lead.attachments?.length || 0) + req.files.length > 10) {
      return next(
        ApiError.badRequest(
          `Cannot exceed 10 attachments per lead. Current: ${lead.attachments?.length || 0}, Uploading: ${req.files.length}`,
        ),
      );
    }

    const isS3Available = Boolean(
      process.env.AWS_REGION &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_S3_BUCKET,
    );

    const newAttachments = [];

    for (const file of req.files) {
      let fileRecord;

      if (isS3Available) {
        // Upload to S3
        const s3Result = await uploadToS3(
          file.buffer,
          file.originalname,
          file.mimetype,
          `lead-attachments/${lead._id}`,
        );
        fileRecord = {
          fileName: s3Result.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: s3Result.url,
          s3Key: s3Result.key,
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        };
      } else {
        // Fallback to local storage
        const uploadDir = path.join(
          process.cwd(),
          "private",
          "uploads",
          "lead-attachments",
          lead._id.toString(),
        );
        fs.mkdirSync(uploadDir, { recursive: true });

        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
        const filePath = path.join(uploadDir, uniqueName);
        fs.writeFileSync(filePath, file.buffer);

        const url = `/api/v1/files/lead-attachments/${lead._id}/${uniqueName}`;
        fileRecord = {
          fileName: uniqueName,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url,
          s3Key: null,
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        };
      }

      newAttachments.push(fileRecord);
    }

    lead.attachments = [...(lead.attachments || []), ...newAttachments];
    lead.lastActivityAt = new Date();
    await lead.save();

    // Log activity
    await LeadActivity.create({
      tenantId: req.user.tenantId,
      leadId: lead._id,
      action: "attachment_uploaded",
      description: `${req.files.length} file(s) uploaded by ${req.user.name}`,
      performedBy: req.user._id,
    });

    logger.info(
      `${req.files.length} attachments uploaded for lead ${lead._id} by ${req.user.name}`,
    );

    successResponse(
      res,
      { attachments: lead.attachments },
      `${req.files.length} file(s) uploaded successfully`,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete an attachment from a lead
 * @route   DELETE /api/leads/:id/attachments/:attachmentId
 * @access  Private (admin/marketing)
 */
const deleteLeadAttachment = asyncHandler(async (req, res, next) => {
  try {
    const { id, attachmentId } = req.params;

    const lead = await Lead.findOne({ _id: id, tenantId: req.user.tenantId });

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    const attachment = lead.attachments?.id(attachmentId);
    if (!attachment) {
      return next(ApiError.notFound("Attachment not found"));
    }

    // Delete from S3 or local
    if (attachment.s3Key) {
      try {
        await deleteFromS3(attachment.s3Key);
      } catch (err) {
        logger.warn(`Failed to delete S3 file: ${attachment.s3Key}`, err);
      }
    } else {
      const relativeAttachmentPath = String(attachment.url || "")
        .replace(/^\/+/, "")
        .replace(/\\/g, "/");
      const localPath = path.resolve(
        process.cwd(),
        "public",
        relativeAttachmentPath,
      );
      const publicRoot = path.resolve(process.cwd(), "public");

      if (localPath.startsWith(publicRoot) && fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      } else {
        logger.warn(
          `Skipped unsafe or missing local attachment path: ${localPath}`,
        );
      }
    }

    lead.attachments.pull(attachmentId);
    lead.lastActivityAt = new Date();
    await lead.save();

    // Log activity
    await LeadActivity.create({
      tenantId: req.user.tenantId,
      leadId: lead._id,
      action: "attachment_deleted",
      description: `File "${attachment.originalName}" deleted by ${req.user.name}`,
      performedBy: req.user._id,
    });

    successResponse(res, null, "Attachment deleted successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore soft-deleted lead
 * @route   PUT /api/leads/:id/restore
 * @access  Private/Admin
 */
const restoreLead = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const lead = await Lead.findOne({
    _id: req.params.id,
    tenantId,
    deletedAt: { $ne: null },
  });

  if (!lead) {
    return next(new ApiError(404, "Deleted lead not found"));
  }

  lead.deletedAt = null;
  lead.deletedBy = null;
  await lead.save();

  AuditLog.record({
    tenantId,
    userId: req.user._id,
    action: "lead.restore",
    entityType: "lead",
    entityId: lead._id,
    description: `Lead restored: ${lead.name}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Lead restored: ${lead.name} by ${req.user.email}`);

  successResponse(res, null, "Lead restored successfully");
});

export {
  getLeads,
  getLeadDetail,
  createLeadManual,
  updateLead,
  updateLeadStatus,
  assignLead,
  markDuplicate,
  mergeDuplicates,
  getLeadAnalytics,
  getUnassignedCount,
  autoAssignLeads,
  deleteLead,
  restoreLead,
  uploadLeadAttachments,
  deleteLeadAttachment,
};
