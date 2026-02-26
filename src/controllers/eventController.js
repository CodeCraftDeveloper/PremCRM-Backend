import Event from "../models/Event.js";
import Client from "../models/Client.js";
import ActivityLog from "../models/ActivityLog.js";
import User from "../models/User.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import {
  getCache,
  setCache,
  deleteCachePattern,
} from "../config/redis.js";
import logger from "../utils/logger.js";

const CACHE_TTL = 3600; // 1 hour

const getTenantUserIds = async (tenantId) => {
  const users = await User.find({ tenantId }, { _id: 1 }).lean();
  return users.map((user) => user._id);
};

const buildEventTenantScope = (tenantId, tenantUserIds = []) => ({
  $or: [
    { tenantId },
    {
      tenantId: { $exists: false },
      createdBy: { $in: tenantUserIds },
    },
    {
      tenantId: null,
      createdBy: { $in: tenantUserIds },
    },
  ],
});

const backfillLegacyEventTenantIds = async (tenantId, tenantUserIds = []) => {
  if (!tenantUserIds.length) return;
  await Event.updateMany(
    {
      $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
      createdBy: { $in: tenantUserIds },
    },
    { $set: { tenantId } },
  );
};

/**
 * @desc    Get all events
 * @route   GET /api/events
 * @access  Private
 */
const getEvents = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    page = 1,
    limit = 10,
    sortBy = "startDate",
    sortOrder = "desc",
    status,
    search,
  } = req.query;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const useCache = process.env.NODE_ENV === "production";

  const eventsCacheKey = `events:all:${tenantId}`;
  // Try cache first (only for simple queries)
  if (useCache && !search && !status && page === 1) {
    const cached = await getCache(eventsCacheKey);
    if (cached) {
      return successResponse(res, cached, "Events retrieved from cache");
    }
  }

  // Build query
  const query = { ...eventScope };

  if (status) {
    if (status === "active") {
      query.status = { $in: ["upcoming", "active"] };
    } else {
      query.status = status;
    }
  }

  if (search) {
    query.$text = { $search: search };
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortOptions = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  // Execute query
  const [events, totalDocs] = await Promise.all([
    Event.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("createdBy", "name email")
      .populate("clientCount"),
    Event.countDocuments(query),
  ]);

  await backfillLegacyEventTenantIds(tenantId, tenantUserIds);

  const totalPages = Math.ceil(totalDocs / parseInt(limit));

  // Cache simple queries
  if (useCache && !search && !status && page === 1) {
    await setCache(
      eventsCacheKey,
      {
        events,
        pagination: { page: 1, limit: parseInt(limit), totalPages, totalDocs },
      },
      CACHE_TTL,
    );
  }

  paginatedResponse(res, events, {
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages,
    totalDocs,
  });
});

/**
 * @desc    Get active events (for dropdowns)
 * @route   GET /api/events/active
 * @access  Private
 */
const getActiveEvents = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const useCache = process.env.NODE_ENV === "production";
  const activeEventsCacheKey = `events:active:${tenantId}`;
  // Try cache first
  if (useCache) {
    const cached = await getCache(activeEventsCacheKey);
    if (cached) {
      return successResponse(res, cached, "Active events retrieved from cache");
    }
  }

  const now = new Date();
  const events = await Event.find({
    ...eventScope,
    status: { $in: ["upcoming", "active"] },
    endDate: { $gte: now },
  })
    .sort({ startDate: 1 })
    .select("name description startDate endDate status")
    .populate("clientCount");

  // Cache result
  if (useCache) {
    await setCache(activeEventsCacheKey, { events }, CACHE_TTL);
  }
  await backfillLegacyEventTenantIds(tenantId, tenantUserIds);

  successResponse(res, { events });
});

/**
 * @desc    Get single event
 * @route   GET /api/events/:id
 * @access  Private
 */
const getEvent = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const event = await Event.findOne({ _id: req.params.id, ...eventScope })
    .populate("createdBy", "name email")
    .populate("assignedUsers", "name email avatar")
    .populate("clientCount");

  if (!event) {
    return next(ApiError.notFound("Event not found"));
  }

  // Get event statistics
  const clientStats = await Client.getStats({ tenantId, event: event._id });

  // Get clients by marketing person for this event
  const clientsByMarketer = await Client.aggregate([
    { $match: { tenantId, event: event._id, isActive: true } },
    {
      $group: {
        _id: "$marketingPerson",
        count: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "marketer",
      },
    },
    { $unwind: "$marketer" },
    {
      $project: {
        name: "$marketer.name",
        email: "$marketer.email",
        count: 1,
        converted: 1,
      },
    },
  ]);

  successResponse(res, { event, clientStats, clientsByMarketer });
});

/**
 * @desc    Create event
 * @route   POST /api/events
 * @access  Private/Admin
 */
const createEvent = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    name,
    description,
    location,
    startDate,
    endDate,
    targetLeads,
    budget,
    tags,
    assignedUsers,
  } = req.body;

  // Validate dates
  if (new Date(startDate) >= new Date(endDate)) {
    return next(ApiError.badRequest("End date must be after start date"));
  }

  // Create event
  const event = await Event.create({
    tenantId,
    name,
    description,
    location,
    startDate,
    endDate,
    targetLeads,
    budget,
    tags,
    assignedUsers,
    createdBy: req.user._id,
  });

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "event_create",
    resourceType: "event",
    resourceId: event._id,
    description: `Created event: ${event.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("events:*");
  await deleteCachePattern(`dashboard:admin:${tenantId}`);

  logger.info(`Event created: ${event.name} by ${req.user.email}`);

  successResponse(res, { event }, "Event created successfully", 201);
});

/**
 * @desc    Update event
 * @route   PUT /api/events/:id
 * @access  Private/Admin
 */
const updateEvent = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const {
    name,
    description,
    location,
    startDate,
    endDate,
    status,
    targetLeads,
    budget,
    tags,
    assignedUsers,
  } = req.body;

  const event = await Event.findOne({ _id: req.params.id, ...eventScope });

  if (!event) {
    return next(ApiError.notFound("Event not found"));
  }

  // Validate dates if both are provided
  if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
    return next(ApiError.badRequest("End date must be after start date"));
  }

  // Update event
  const updatedEvent = await Event.findOneAndUpdate(
    { _id: req.params.id, ...eventScope },
    {
      name,
      description,
      location,
      startDate,
      endDate,
      status,
      targetLeads,
      budget,
      tags,
      assignedUsers,
    },
    { new: true, runValidators: true },
  ).populate("clientCount");

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "event_update",
    resourceType: "event",
    resourceId: updatedEvent._id,
    description: `Updated event: ${updatedEvent.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("events:*");
  await deleteCachePattern(`dashboard:admin:${tenantId}`);

  logger.info(`Event updated: ${updatedEvent.name} by ${req.user.email}`);

  successResponse(res, { event: updatedEvent }, "Event updated successfully");
});

/**
 * @desc    Delete event
 * @route   DELETE /api/events/:id
 * @access  Private/Admin
 */
const deleteEvent = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const event = await Event.findOne({ _id: req.params.id, ...eventScope });

  if (!event) {
    return next(ApiError.notFound("Event not found"));
  }

  // Check if event has clients
  const clientCount = await Client.countDocuments({ tenantId, event: event._id });
  if (clientCount > 0) {
    return next(
      ApiError.badRequest(
        `Cannot delete event with ${clientCount} associated clients. Reassign or delete clients first.`,
      ),
    );
  }

  await Event.deleteOne({ _id: req.params.id, ...eventScope });

  // Log activity
  await ActivityLog.log({
    tenantId,
    user: req.user._id,
    action: "event_delete",
    resourceType: "event",
    resourceId: event._id,
    description: `Deleted event: ${event.name}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("events:*");
  await deleteCachePattern(`dashboard:admin:${tenantId}`);

  logger.info(`Event deleted: ${event.name} by ${req.user.email}`);

  successResponse(res, null, "Event deleted successfully");
});

/**
 * @desc    Get event statistics
 * @route   GET /api/events/:id/stats
 * @access  Private
 */
const getEventStats = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const tenantUserIds = await getTenantUserIds(tenantId);
  const eventScope = buildEventTenantScope(tenantId, tenantUserIds);
  const event = await Event.findOne({ _id: req.params.id, ...eventScope });

  if (!event) {
    return next(ApiError.notFound("Event not found"));
  }

  const stats = await Client.getStats({ tenantId, event: event._id });

  // Get daily lead trend for the event
  const dailyTrend = await Client.aggregate([
    { $match: { tenantId, event: event._id } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 30 },
  ]);

  successResponse(res, { stats, dailyTrend });
});

export {
  getEvents,
  getActiveEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  getEventStats,
};
