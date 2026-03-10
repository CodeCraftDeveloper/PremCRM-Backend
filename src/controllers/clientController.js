import Client from "../models/Client.js";
import Remark from "../models/Remark.js";
import Event from "../models/Event.js";
import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import AuditLog from "../models/AuditLog.js";
import UsageMetric from "../models/UsageMetric.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import { uploadToS3, deleteFromS3, getSignedFileUrl } from "../config/s3.js";
import { deleteCachePattern } from "../config/redis.js";
import logger from "../utils/logger.js";

const normalizePhone = (phone = "") => String(phone).replace(/\D/g, "");
const isS3Configured = () =>
  Boolean(
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET,
  );

const LOCAL_KEY_PREFIX = "local:";

const localKeyToFilePath = (key) => {
  if (!key?.startsWith(LOCAL_KEY_PREFIX)) return null;
  const relative = key.slice(LOCAL_KEY_PREFIX.length).replace(/^\/+/, "");
  return path.resolve(process.cwd(), "private", relative);
};

const saveVisitingCardLocally = async (file, clientId) => {
  const ext = path.extname(file.originalname || "") || ".jpg";
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const relativeDir = path.join("uploads", "visiting-cards", String(clientId));
  const absoluteDir = path.resolve(process.cwd(), "private", relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true });

  const relativePath = path.join(relativeDir, filename).replace(/\\/g, "/");
  const absolutePath = path.resolve(process.cwd(), "private", relativePath);
  await fs.writeFile(absolutePath, file.buffer);

  return {
    key: `${LOCAL_KEY_PREFIX}${relativePath}`,
    url: `/${relativePath}`,
  };
};

const findExistingContactOwner = async ({ tenantId, email, phone }) => {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const normalizedPhone = normalizePhone(phone);
  const or = [];

  if (normalizedEmail) {
    or.push({ email: normalizedEmail });
  }

  if (normalizedPhone) {
    // Match exact value or formatting variants that end with the same core digits.
    or.push({ phone: { $regex: `${normalizedPhone}$` } });
    or.push({ alternatePhone: { $regex: `${normalizedPhone}$` } });
  }

  if (or.length === 0) return null;

  return Client.findOne({
    tenantId,
    isActive: true,
    $or: or,
    marketingPerson: { $ne: null },
  })
    .sort({ updatedAt: -1 })
    .select("marketingPerson");
};

const pickLeastLoadedMarketingUser = async (tenantId) => {
  const marketers = await User.find({
    tenantId,
    role: "marketing",
    isActive: true,
  }).select("_id");

  if (!marketers.length) {
    throw ApiError.badRequest(
      "No active marketing manager available for assignment",
    );
  }

  const marketerIds = marketers.map((marketer) => marketer._id);
  const workloads = await Client.aggregate([
    {
      $match: {
        isActive: true,
        tenantId,
        marketingPerson: { $in: marketerIds },
        followUpStatus: { $nin: ["converted", "lost"] },
      },
    },
    {
      $group: {
        _id: "$marketingPerson",
        count: { $sum: 1 },
      },
    },
  ]);

  const loadMap = new Map(
    workloads.map((item) => [String(item._id), item.count]),
  );
  return marketers.reduce((leastLoaded, current) => {
    const leastCount = loadMap.get(String(leastLoaded._id)) || 0;
    const currentCount = loadMap.get(String(current._id)) || 0;
    return currentCount < leastCount ? current : leastLoaded;
  }, marketers[0]);
};

const resolveMarketingAssignee = async ({
  tenantId,
  requestedMarketingPerson,
  email,
  phone,
}) => {
  const existing = await findExistingContactOwner({ tenantId, email, phone });
  if (existing?.marketingPerson) {
    return existing.marketingPerson;
  }

  if (requestedMarketingPerson) {
    const marketer = await User.findOne({
      tenantId,
      _id: requestedMarketingPerson,
      role: "marketing",
      isActive: true,
    }).select("_id");

    if (!marketer) {
      throw ApiError.badRequest("Selected marketing person is invalid");
    }

    return marketer._id;
  }

  const leastLoaded = await pickLeastLoadedMarketingUser(tenantId);
  return leastLoaded._id;
};

const resolveFollowUpOwnerForExistingClient = async (client, tenantId) => {
  if (client.createdBy) {
    const creator = await User.findOne({
      tenantId,
      _id: client.createdBy,
      role: "marketing",
      isActive: true,
    }).select("_id");
    if (creator) return creator._id;
  }

  if (client.marketingPerson) {
    const currentOwner = await User.findOne({
      tenantId,
      _id: client.marketingPerson,
      role: "marketing",
      isActive: true,
    }).select("_id");
    if (currentOwner) return currentOwner._id;
  }

  return resolveMarketingAssignee({
    tenantId,
    requestedMarketingPerson: null,
    email: client.email,
    phone: client.phone,
  });
};

/**
 * @desc    Get all clients
 * @route   GET /api/clients
 * @access  Private
 */
const getClients = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    sortOrder = "desc",
    event,
    marketingPerson,
    followUpStatus,
    priority,
    search,
    startDate,
    endDate,
  } = req.query;

  // Build query
  const query = { tenantId, isActive: true };

  // Role-based filtering: Marketing users can only see their own clients
  if (req.user.role === "marketing") {
    query.marketingPerson = req.user._id;
  } else if (marketingPerson) {
    query.marketingPerson = marketingPerson;
  }

  if (event) query.event = event;
  if (followUpStatus) query.followUpStatus = followUpStatus;
  if (priority) query.priority = priority;

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { companyName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortOptions = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  // Execute query
  const [clients, totalDocs] = await Promise.all([
    Client.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("event", "name status")
      .populate("marketingPerson", "name email avatar")
      .populate("createdBy", "name email")
      .populate("lastContactedBy", "name email")
      .populate("remarkCount"),
    Client.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / parseInt(limit));

  paginatedResponse(res, clients, {
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages,
    totalDocs,
  });
});

/**
 * @desc    Get single client
 * @route   GET /api/clients/:id
 * @access  Private
 */
const getClient = asyncHandler(async (req, res, next) => {
  const client = await Client.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  })
    .populate("event", "name description status startDate endDate location")
    .populate("marketingPerson", "name email avatar phone")
    .populate("createdBy", "name email")
    .populate("lastContactedBy", "name email")
    .populate({
      path: "remarks",
      options: { sort: { createdAt: -1 }, limit: 20 },
      populate: { path: "user", select: "name email avatar" },
    });

  if (!client) {
    return next(ApiError.notFound("Client not found"));
  }

  // Check access
  if (
    req.user.role === "marketing" &&
    client.marketingPerson._id.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("Access denied"));
  }

  // Get signed URL for visiting card if exists
  let visitingCardUrl = null;
  if (client.visitingCard?.key) {
    try {
      if (client.visitingCard.key.startsWith(LOCAL_KEY_PREFIX)) {
        // Use authenticated file route instead of direct static serving
        const relativePath = client.visitingCard.key
          .slice(LOCAL_KEY_PREFIX.length)
          .replace(/^\/+/, "");
        const filename = path.basename(relativePath);
        visitingCardUrl = `/api/v1/files/visiting-cards/${client._id}/${filename}`;
      } else {
        visitingCardUrl = await getSignedFileUrl(client.visitingCard.key);
      }
    } catch (error) {
      logger.warn(
        `Failed to get signed URL for visiting card: ${error.message}`,
      );
    }
  }

  successResponse(res, {
    client: {
      ...client.toObject(),
      visitingCardUrl,
    },
  });
});

/**
 * @desc    Create client
 * @route   POST /api/clients
 * @access  Private
 */
const createClient = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    name,
    companyName,
    email,
    phone,
    alternatePhone,
    address,
    event,
    marketingPerson,
    followUpStatus,
    priority,
    nextFollowUpDate,
    industry,
    designation,
    source,
    estimatedValue,
    notes,
    tags,
  } = req.body;

  // Verify event exists and is active
  const eventDoc = await Event.findOne({ _id: event, tenantId });
  if (!eventDoc) {
    return next(ApiError.notFound("Event not found"));
  }

  const existingOwnerClient = await findExistingContactOwner({
    tenantId,
    email,
    phone,
  });
  if (req.user.role === "marketing" && existingOwnerClient?.marketingPerson) {
    const existingOwnerId = String(existingOwnerClient.marketingPerson);
    if (existingOwnerId !== String(req.user._id)) {
      const existingOwner = await User.findOne({
        _id: existingOwnerId,
        tenantId,
      }).select("name email");
      return next(
        ApiError.conflict(
          `This client is already assigned to ${existingOwner?.name || "another marketing manager"}. Please update the existing client instead of creating a duplicate.`,
        ),
      );
    }
  }

  const assignedMarketingPerson =
    req.user.role === "admin"
      ? await resolveMarketingAssignee({
          tenantId,
          requestedMarketingPerson: marketingPerson,
          email,
          phone,
        })
      : req.user._id;

  // Create client
  const client = await Client.create({
    tenantId,
    name,
    companyName,
    email,
    phone,
    alternatePhone,
    address,
    event,
    marketingPerson: assignedMarketingPerson,
    createdBy: req.user._id,
    followUpStatus: followUpStatus || "new",
    priority: priority || "medium",
    nextFollowUpDate,
    industry,
    designation,
    source,
    estimatedValue,
    notes,
    tags,
  });

  // Create initial remark
  if (notes) {
    await Remark.create({
      client: client._id,
      user: req.user._id,
      tenantId,
      content: `Initial note: ${notes}`,
      type: "note",
    });
  }

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "client_create",
    resourceType: "client",
    resourceId: client._id,
    description: `Created client: ${client.name}`,
    metadata: { event: eventDoc.name },
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("clients:*");
  await deleteCachePattern("dashboard:*");

  // Track usage metric
  UsageMetric.increment(tenantId, "leadsCreated", 1);

  // Audit log
  AuditLog.record({
    tenantId,
    userId: req.user._id,
    action: "client.create",
    entityType: "client",
    entityId: client._id,
    description: `Client created: ${client.name}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Client created: ${client.name} by ${req.user.email}`);

  const populatedClient = await Client.findOne({ _id: client._id, tenantId })
    .populate("event", "name status")
    .populate("marketingPerson", "name email")
    .populate("createdBy", "name email")
    .populate("lastContactedBy", "name email");

  successResponse(
    res,
    { client: populatedClient },
    "Client created successfully",
    201,
  );
});

/**
 * @desc    Update client
 * @route   PUT /api/clients/:id
 * @access  Private
 */
const updateClient = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    name,
    companyName,
    email,
    phone,
    alternatePhone,
    address,
    event,
    followUpStatus,
    priority,
    nextFollowUpDate,
    industry,
    designation,
    source,
    estimatedValue,
    notes,
    tags,
    lastContactedDate,
  } = req.body;

  const client = await Client.findOne({ _id: req.params.id, tenantId });

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

  if (event) {
    const eventDoc = await Event.findOne({ _id: event, tenantId });
    if (!eventDoc) {
      return next(ApiError.notFound("Event not found"));
    }
  }

  // Track status change
  const oldStatus = client.followUpStatus;
  const statusChanged = followUpStatus && followUpStatus !== oldStatus;

  let marketingPersonForUpdate = await resolveFollowUpOwnerForExistingClient(
    client,
    tenantId,
  );

  // Update client
  const updatedClient = await Client.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    {
      name,
      companyName,
      email,
      phone,
      alternatePhone,
      address,
      event,
      followUpStatus,
      priority,
      nextFollowUpDate,
      industry,
      designation,
      source,
      estimatedValue,
      notes,
      tags,
      lastContactedDate,
      lastContactedBy: lastContactedDate
        ? req.user._id
        : client.lastContactedBy,
      marketingPerson: marketingPersonForUpdate,
    },
    { new: true, runValidators: true },
  )
    .populate("event", "name status")
    .populate("marketingPerson", "name email")
    .populate("createdBy", "name email")
    .populate("lastContactedBy", "name email");

  // Create status change remark if status changed
  if (statusChanged) {
    await Remark.createStatusChangeRemark(
      tenantId,
      client._id,
      req.user._id,
      oldStatus,
      followUpStatus,
    );

    // Log status change
    await ActivityLog.log({
      tenantId,
      user: req.user._id,
      action: "client_status_change",
      resourceType: "client",
      resourceId: client._id,
      description: `Client status changed: ${oldStatus} -> ${followUpStatus}`,
      metadata: { oldStatus, newStatus: followUpStatus },
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Audit log for status change
    AuditLog.record({
      tenantId,
      userId: req.user._id,
      action: "client.status_change",
      entityType: "client",
      entityId: client._id,
      description: `Client status: ${oldStatus} -> ${followUpStatus}`,
      metadata: { oldStatus, newStatus: followUpStatus },
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });
  }

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "client_update",
    resourceType: "client",
    resourceId: client._id,
    description: `Updated client: ${client.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("clients:*");
  await deleteCachePattern("dashboard:*");

  logger.info(`Client updated: ${client.name} by ${req.user.email}`);

  successResponse(
    res,
    { client: updatedClient },
    "Client updated successfully",
  );
});

/**
 * @desc    Delete client (soft delete)
 * @route   DELETE /api/clients/:id
 * @access  Private
 */
const deleteClient = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const client = await Client.findOne({ _id: req.params.id, tenantId });

  if (!client) {
    return next(ApiError.notFound("Client not found"));
  }

  // Check access (only admin or owner)
  if (
    req.user.role === "marketing" &&
    client.marketingPerson.toString() !== req.user._id.toString()
  ) {
    return next(ApiError.forbidden("Access denied"));
  }

  // Soft delete with audit trail
  client.isActive = false;
  client.deletedAt = new Date();
  client.deletedBy = req.user._id;
  await client.save();

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "client_delete",
    resourceType: "client",
    resourceId: client._id,
    description: `Deleted client: ${client.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Audit log
  AuditLog.record({
    tenantId,
    userId: req.user._id,
    action: "client.delete",
    entityType: "client",
    entityId: client._id,
    description: `Client soft-deleted: ${client.name}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("clients:*");
  await deleteCachePattern("dashboard:*");

  logger.info(`Client deleted: ${client.name} by ${req.user.email}`);

  successResponse(res, null, "Client deleted successfully");
});

/**
 * @desc    Upload visiting card
 * @route   POST /api/clients/:id/visiting-card
 * @access  Private
 */
const uploadVisitingCard = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const client = await Client.findOne({ _id: req.params.id, tenantId });

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

  if (!req.file) {
    return next(ApiError.badRequest("Please upload an image"));
  }

  // Delete old visiting card if exists
  if (client.visitingCard?.key) {
    try {
      const localPath = localKeyToFilePath(client.visitingCard.key);
      if (localPath) {
        await fs.unlink(localPath).catch(() => {});
      } else {
        await deleteFromS3(client.visitingCard.key);
      }
    } catch (error) {
      logger.warn(`Failed to delete old visiting card: ${error.message}`);
    }
  }

  let result;
  if (isS3Configured()) {
    try {
      result = await uploadToS3(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        `visiting-cards/${client._id}`,
      );
    } catch (error) {
      logger.warn(
        `S3 upload failed for client ${client._id}. Falling back to local storage: ${error.message}`,
      );
      result = await saveVisitingCardLocally(req.file, client._id);
    }
  } else {
    result = await saveVisitingCardLocally(req.file, client._id);
  }

  // Update client
  client.visitingCard = {
    url: result.url,
    key: result.key,
    uploadedAt: new Date(),
  };
  await client.save();
  await client.populate("event", "name status");
  await client.populate("marketingPerson", "name email avatar");

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "file_upload",
    resourceType: "client",
    resourceId: client._id,
    description: `Uploaded visiting card for: ${client.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Visiting card uploaded for client: ${client.name}`);

  successResponse(res, { client }, "Visiting card uploaded successfully");
});

/**
 * @desc    Get pending follow-ups
 * @route   GET /api/clients/follow-ups/pending
 * @access  Private
 */
const getPendingFollowUps = asyncHandler(async (req, res, next) => {
  const { days = 7 } = req.query;
  const parsedDays = Number.parseInt(days, 10);
  const safeDays = Number.isNaN(parsedDays) || parsedDays < 1 ? 7 : parsedDays;
  const followUpFilter = {
    tenantId: req.user.tenantId,
    isActive: true,
    followUpStatus: { $nin: ["converted", "lost"] },
    nextFollowUpDate: {
      $ne: null,
      $lte: new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000),
    },
  };
  if (req.user.role === "marketing") {
    followUpFilter.marketingPerson = req.user._id;
  }

  const clients = await Client.find(followUpFilter)
    .sort({ nextFollowUpDate: 1 })
    .populate("event", "name")
    .populate("marketingPerson", "name email")
    .limit(50);

  successResponse(res, { clients, count: clients.length });
});

/**
 * @desc    Get client statistics
 * @route   GET /api/clients/stats
 * @access  Private
 */
const getClientStats = asyncHandler(async (req, res, next) => {
  const { event, marketingPerson } = req.query;

  const filter = { tenantId: req.user.tenantId, isActive: true };

  if (req.user.role === "marketing") {
    filter.marketingPerson = req.user._id;
  } else if (marketingPerson) {
    filter.marketingPerson = marketingPerson;
  }

  if (event) filter.event = event;

  const stats = await Client.getStats(filter);

  successResponse(res, { stats });
});

/**
 * @desc    Bulk assign clients to marketing person
 * @route   PUT /api/clients/bulk-assign
 * @access  Private/Admin
 */
const bulkAssignClients = asyncHandler(async (req, res, next) => {
  const { clientIds, marketingPersonId } = req.body;
  const tenantId = req.user.tenantId;

  if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
    return next(ApiError.badRequest("Please provide client IDs"));
  }

  const marketer = await User.findOne({
    _id: marketingPersonId,
    tenantId,
    role: "marketing",
    isActive: true,
  }).select("_id");
  if (!marketer) {
    return next(ApiError.badRequest("Selected marketing person is invalid"));
  }

  const result = await Client.updateMany(
    { _id: { $in: clientIds }, tenantId },
    { marketingPerson: marketingPersonId },
  );

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "client_assign",
    resourceType: "client",
    description: `Bulk assigned ${result.modifiedCount} clients to ${marketingPersonId}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("clients:*");
  await deleteCachePattern("dashboard:*");

  successResponse(
    res,
    { modifiedCount: result.modifiedCount },
    "Clients assigned successfully",
  );
});

/**
 * @desc    Restore soft-deleted client
 * @route   PUT /api/clients/:id/restore
 * @access  Private/Admin
 */
const restoreClient = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const client = await Client.findOne({
    _id: req.params.id,
    tenantId,
    deletedAt: { $ne: null },
  });

  if (!client) {
    return next(ApiError.notFound("Deleted client not found"));
  }

  client.isActive = true;
  client.deletedAt = null;
  client.deletedBy = null;
  await client.save();

  AuditLog.record({
    tenantId,
    userId: req.user._id,
    action: "client.restore",
    entityType: "client",
    entityId: client._id,
    description: `Client restored: ${client.name}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  await deleteCachePattern("clients:*");
  await deleteCachePattern("dashboard:*");

  logger.info(`Client restored: ${client.name} by ${req.user.email}`);

  successResponse(res, null, "Client restored successfully");
});

export {
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  restoreClient,
  uploadVisitingCard,
  getPendingFollowUps,
  getClientStats,
  bulkAssignClients,
};
