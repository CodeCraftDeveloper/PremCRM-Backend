import Remark from "../models/Remark.js";
import Client from "../models/Client.js";
import ActivityLog from "../models/ActivityLog.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

/**
 * @desc    Get remarks for a client
 * @route   GET /api/clients/:clientId/remarks
 * @access  Private
 */
const getRemarks = asyncHandler(async (req, res, next) => {
  const { clientId } = req.params;
  const { page = 1, limit = 20, type } = req.query;

  // Verify client exists within current tenant
  const client = await Client.findOne({
    _id: clientId,
    tenantId: req.user.tenantId,
  });
  if (!client) {
    return next(ApiError.notFound("Client not found"));
  }

  // Check access
  if (
    req.user.role === "marketing" &&
    client.marketingPerson.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("Access denied"));
  }

  // Build query
  const query = { client: clientId };
  if (type) query.type = type;

  // Get remarks with pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [remarks, totalDocs] = await Promise.all([
    Remark.find(query)
      .sort({ isPinned: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("user", "name email avatar"),
    Remark.countDocuments(query),
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
 * @desc    Create a remark for a client
 * @route   POST /api/clients/:clientId/remarks
 * @access  Private
 */
const createRemark = asyncHandler(async (req, res, next) => {
  const { clientId } = req.params;
  const { content, type = "note", isInternal = false } = req.body;

  // Verify client exists within current tenant
  const client = await Client.findOne({
    _id: clientId,
    tenantId: req.user.tenantId,
  });
  if (!client) {
    return next(ApiError.notFound("Client not found"));
  }

  // Check access
  if (
    req.user.role === "marketing" &&
    client.marketingPerson.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("Access denied"));
  }

  // Create remark
  const remark = await Remark.create({
    client: clientId,
    user: req.user._id,
    content,
    type,
    isInternal,
  });

  // Update client's last contacted date if it's a contact-related remark
  if (["call", "email", "meeting", "follow_up"].includes(type)) {
    await Client.findByIdAndUpdate(clientId, {
      lastContactedDate: new Date(),
      lastContactedBy: req.user._id,
    });
  }

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "remark_create",
    resourceType: "remark",
    resourceId: remark._id,
    description: `Added ${type} remark for client: ${client.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  const populatedRemark = await Remark.findById(remark._id).populate(
    "user",
    "name email avatar",
  );

  logger.info(`Remark added for client: ${client.name} by ${req.user.email}`);

  successResponse(
    res,
    { remark: populatedRemark },
    "Remark added successfully",
    201,
  );
});

/**
 * @desc    Update a remark
 * @route   PUT /api/remarks/:id
 * @access  Private
 */
const updateRemark = asyncHandler(async (req, res, next) => {
  const { content, isPinned } = req.body;

  const remark = await Remark.findById(req.params.id).populate(
    "client",
    "tenantId",
  );

  if (!remark) {
    return next(ApiError.notFound("Remark not found"));
  }
  if (
    !remark.client ||
    String(remark.client.tenantId) !== String(req.user.tenantId)
  ) {
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

  const updatedRemark = await Remark.findByIdAndUpdate(
    req.params.id,
    { content, isPinned },
    { new: true, runValidators: true },
  ).populate("user", "name email avatar");

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "remark_update",
    resourceType: "remark",
    resourceId: remark._id,
    description: `Updated remark: ${req.params.id}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Remark updated: ${req.params.id} by ${req.user.email}`);

  successResponse(
    res,
    { remark: updatedRemark },
    "Remark updated successfully",
  );
});

/**
 * @desc    Delete a remark
 * @route   DELETE /api/remarks/:id
 * @access  Private
 */
const deleteRemark = asyncHandler(async (req, res, next) => {
  const remark = await Remark.findById(req.params.id).populate(
    "client",
    "tenantId",
  );

  if (!remark) {
    return next(ApiError.notFound("Remark not found"));
  }
  if (
    !remark.client ||
    String(remark.client.tenantId) !== String(req.user.tenantId)
  ) {
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

  await Remark.findByIdAndDelete(req.params.id);

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "remark_delete",
    resourceType: "remark",
    resourceId: remark._id,
    description: `Deleted remark: ${req.params.id}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Remark deleted: ${req.params.id} by ${req.user.email}`);

  successResponse(res, null, "Remark deleted successfully");
});

/**
 * @desc    Get remark timeline for a client
 * @route   GET /api/clients/:clientId/timeline
 * @access  Private
 */
const getClientTimeline = asyncHandler(async (req, res, next) => {
  const { clientId } = req.params;
  const { limit = 50, page = 1 } = req.query;

  // Verify client exists within current tenant
  const client = await Client.findOne({
    _id: clientId,
    tenantId: req.user.tenantId,
  });
  if (!client) {
    return next(ApiError.notFound("Client not found"));
  }

  // Check access
  if (
    req.user.role === "marketing" &&
    client.marketingPerson.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("Access denied"));
  }

  const timeline = await Remark.getTimeline(clientId, {
    limit: parseInt(limit),
    page: parseInt(page),
  });

  successResponse(res, {
    timeline,
    client: { name: client.name, id: client._id },
  });
});

export {
  getRemarks,
  createRemark,
  updateRemark,
  deleteRemark,
  getClientTimeline,
};
