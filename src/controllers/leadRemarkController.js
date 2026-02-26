import LeadRemark from "../models/LeadRemark.js";
import { Lead } from "../models/index.js";
import ActivityLog from "../models/ActivityLog.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

/**
 * @desc    Get remarks for a lead
 * @route   GET /api/leads/:leadId/remarks
 * @access  Private
 */
const getLeadRemarks = asyncHandler(async (req, res, next) => {
  const { leadId } = req.params;
  const { page = 1, limit = 20, type } = req.query;

  // Verify lead exists within current tenant
  const lead = await Lead.findOne({ _id: leadId, tenantId: req.user.tenantId });
  if (!lead) {
    return next(ApiError.notFound("Lead not found"));
  }

  // Build query
  const query = { lead: leadId };
  if (type) query.type = type;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [remarks, totalDocs] = await Promise.all([
    LeadRemark.find(query)
      .sort({ isPinned: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("user", "name email avatar"),
    LeadRemark.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / parseInt(limit));

  paginatedResponse(res, remarks, {
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages,
    totalDocs,
  });
});

/**
 * @desc    Create a remark for a lead
 * @route   POST /api/leads/:leadId/remarks
 * @access  Private (admin/marketing)
 */
const createLeadRemark = asyncHandler(async (req, res, next) => {
  const { leadId } = req.params;
  const { content, type = "note", isInternal = false } = req.body;

  // Verify lead exists within current tenant
  const lead = await Lead.findOne({ _id: leadId, tenantId: req.user.tenantId });
  if (!lead) {
    return next(ApiError.notFound("Lead not found"));
  }

  // Create remark
  const remark = await LeadRemark.create({
    lead: leadId,
    user: req.user._id,
    content,
    type,
    isInternal,
  });

  // Update lead's last contacted date if contact-related
  if (["call", "email", "meeting", "follow_up"].includes(type)) {
    await Lead.findByIdAndUpdate(leadId, {
      lastContactedAt: new Date(),
      contactAttempts: (lead.contactAttempts || 0) + 1,
      lastActivityAt: new Date(),
    });
  } else {
    await Lead.findByIdAndUpdate(leadId, {
      lastActivityAt: new Date(),
    });
  }

  // Log activity
  await ActivityLog.log({
    tenantId: lead.tenantId,
    user: req.user._id,
    action: "lead_remark_create",
    resourceType: "lead_remark",
    resourceId: remark._id,
    description: `Added ${type} remark for lead: ${lead.fullName || lead.firstName}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  const populatedRemark = await LeadRemark.findById(remark._id).populate(
    "user",
    "name email avatar",
  );

  logger.info(
    `Lead remark added for: ${lead.fullName || lead.firstName} by ${req.user.email}`,
  );

  successResponse(
    res,
    { remark: populatedRemark },
    "Remark added successfully",
    201,
  );
});

/**
 * @desc    Update a lead remark
 * @route   PUT /api/leads/remarks/:id
 * @access  Private
 */
const updateLeadRemark = asyncHandler(async (req, res, next) => {
  const { content, isPinned } = req.body;

  const remark = await LeadRemark.findById(req.params.id).populate(
    "lead",
    "tenantId",
  );

  if (!remark) {
    return next(ApiError.notFound("Remark not found"));
  }
  if (!remark.lead || String(remark.lead.tenantId) !== String(req.user.tenantId)) {
    return next(ApiError.notFound("Remark not found"));
  }

  // Only creator or admin can edit
  if (
    req.user.role !== "admin" &&
    remark.user.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("You can only edit your own remarks"));
  }

  // System remarks cannot be edited
  if (remark.type === "status_change" || remark.type === "system") {
    return next(ApiError.forbidden("System remarks cannot be edited"));
  }

  const updatedRemark = await LeadRemark.findByIdAndUpdate(
    req.params.id,
    { content, isPinned },
    { new: true, runValidators: true },
  ).populate("user", "name email avatar");

  logger.info(`Lead remark updated: ${req.params.id} by ${req.user.email}`);

  successResponse(
    res,
    { remark: updatedRemark },
    "Remark updated successfully",
  );
});

/**
 * @desc    Delete a lead remark
 * @route   DELETE /api/leads/remarks/:id
 * @access  Private
 */
const deleteLeadRemark = asyncHandler(async (req, res, next) => {
  const remark = await LeadRemark.findById(req.params.id).populate(
    "lead",
    "tenantId",
  );

  if (!remark) {
    return next(ApiError.notFound("Remark not found"));
  }
  if (!remark.lead || String(remark.lead.tenantId) !== String(req.user.tenantId)) {
    return next(ApiError.notFound("Remark not found"));
  }

  // Only creator or admin can delete
  if (
    req.user.role !== "admin" &&
    remark.user.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("You can only delete your own remarks"));
  }

  // System remarks cannot be deleted
  if (remark.type === "status_change" || remark.type === "system") {
    return next(ApiError.forbidden("System remarks cannot be deleted"));
  }

  await LeadRemark.findByIdAndDelete(req.params.id);

  logger.info(`Lead remark deleted: ${req.params.id} by ${req.user.email}`);

  successResponse(res, null, "Remark deleted successfully");
});

export { getLeadRemarks, createLeadRemark, updateLeadRemark, deleteLeadRemark };
