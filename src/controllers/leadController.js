import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import { Lead, Website, LeadActivity } from "../models/index.js";
import LeadService from "../core/leads/LeadService.js";
import DuplicateDetectionService from "../core/leads/DuplicateDetectionService.js";
import AssignmentService from "../core/leads/AssignmentService.js";
import { uploadToS3, deleteFromS3 } from "../config/s3.js";
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
    if (assignedTo) filters.assignedTo = assignedTo;
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
    const lead = await Lead.findById(req.params.id)
      .populate("assignedTo", "name email")
      .populate("websiteId", "name domain")
      .populate("duplicateOf", "fullName email source");

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Check tenant access
    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
    }

    // Get activity history
    const activities = await LeadActivity.find({ leadId: req.params.id })
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
    const { firstName, email, websiteId, ...otherData } = req.body;

    if (!firstName || !email) {
      return next(ApiError.badRequest("First name and email are required"));
    }

    if (!websiteId) {
      return next(ApiError.badRequest("Website ID is required"));
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

    successResponse(
      res,
      { leadId: result.leadId },
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
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Check tenant access
    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
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

    const updatedLead = await Lead.findByIdAndUpdate(req.params.id, updates, {
      new: true,
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

    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Check tenant access
    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
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

    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Check tenant access
    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
    }

    const updatedLead = await DuplicateDetectionService.markAsDuplicate(
      req.params.id,
      originalLeadId,
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

    const originalLead = await Lead.findById(id);

    if (!originalLead) {
      return next(ApiError.notFound("Original lead not found"));
    }

    // Check tenant access
    if (originalLead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
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
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    // Check tenant access
    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
    }

    await Lead.findByIdAndDelete(req.params.id);

    // Clean up related activities
    await LeadActivity.deleteMany({ leadId: req.params.id });

    logger.info(`Lead ${req.params.id} deleted by ${req.user.name}`);

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
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
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
          "public",
          "uploads",
          "lead-attachments",
          lead._id.toString(),
        );
        fs.mkdirSync(uploadDir, { recursive: true });

        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
        const filePath = path.join(uploadDir, uniqueName);
        fs.writeFileSync(filePath, file.buffer);

        const url = `/uploads/lead-attachments/${lead._id}/${uniqueName}`;
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

    const lead = await Lead.findById(id);

    if (!lead) {
      return next(ApiError.notFound("Lead not found"));
    }

    if (lead.tenantId.toString() !== req.user.tenantId.toString()) {
      return next(ApiError.forbidden("Access denied"));
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
        logger.warn(`Skipped unsafe or missing local attachment path: ${localPath}`);
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
  uploadLeadAttachments,
  deleteLeadAttachment,
};
