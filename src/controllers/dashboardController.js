import Client from "../models/Client.js";
import Event from "../models/Event.js";
import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import { asyncHandler, successResponse } from "../utils/apiResponse.js";
import { getCache, setCache } from "../config/redis.js";

const CACHE_TTL = 300; // 5 minutes for dashboard data

/**
 * @desc    Get admin dashboard data
 * @route   GET /api/dashboard/admin
 * @access  Private/Admin
 */
const getAdminDashboard = asyncHandler(async (req, res, next) => {
  // Try cache first
  const cached = await getCache("dashboard:admin");
  if (cached) {
    return successResponse(res, cached, "Dashboard data retrieved from cache");
  }

  // Get overview stats
  const [totalClients, totalEvents, totalUsers, activeEvents] =
    await Promise.all([
      Client.countDocuments({ isActive: true }),
      Event.countDocuments(),
      User.countDocuments({ isActive: true }),
      Event.countDocuments({ status: { $in: ["upcoming", "active"] } }),
    ]);

  // Get client stats by status
  const clientStats = await Client.getStats();

  // Get recent clients
  const recentClients = await Client.find({ isActive: true })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate("event", "name")
    .populate("marketingPerson", "name");

  // Get top performing marketing users
  const topMarketers = await Client.aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: "$marketingPerson",
        totalClients: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
        totalValue: { $sum: "$estimatedValue" },
      },
    },
    { $sort: { converted: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $project: {
        name: "$user.name",
        email: "$user.email",
        avatar: "$user.avatar",
        totalClients: 1,
        converted: 1,
        totalValue: 1,
        conversionRate: {
          $round: [
            {
              $multiply: [
                { $divide: ["$converted", { $max: ["$totalClients", 1] }] },
                100,
              ],
            },
            1,
          ],
        },
      },
    },
  ]);

  // Get event performance
  const eventPerformance = await Client.aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: "$event",
        totalClients: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
      },
    },
    { $sort: { totalClients: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "events",
        localField: "_id",
        foreignField: "_id",
        as: "event",
      },
    },
    { $unwind: "$event" },
    {
      $project: {
        name: "$event.name",
        status: "$event.status",
        totalClients: 1,
        converted: 1,
      },
    },
  ]);

  // Get monthly trend (last 6 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const monthlyTrend = await Client.aggregate([
    { $match: { createdAt: { $gte: sixMonthsAgo } } },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
        count: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  // Get pending follow-ups count
  const pendingFollowUps = await Client.countDocuments({
    isActive: true,
    followUpStatus: { $nin: ["converted", "lost"] },
    nextFollowUpDate: { $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  });

  // Get recent activity
  const recentActivity = await ActivityLog.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .populate("user", "name email avatar");

  const dashboardData = {
    overview: {
      totalClients,
      totalEvents,
      totalUsers,
      activeEvents,
      pendingFollowUps,
    },
    clientStats,
    recentClients,
    topMarketers,
    eventPerformance,
    monthlyTrend,
    recentActivity,
  };

  // Cache result
  await setCache("dashboard:admin", dashboardData, CACHE_TTL);

  successResponse(res, dashboardData);
});

/**
 * @desc    Get marketing user dashboard data
 * @route   GET /api/dashboard/marketing
 * @access  Private/Marketing
 */
const getMarketingDashboard = asyncHandler(async (req, res, next) => {
  const userId = req.user._id;

  // Try cache first
  const cacheKey = `dashboard:marketing:${userId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    return successResponse(res, cached, "Dashboard data retrieved from cache");
  }

  // Get user's client stats
  const clientStats = await Client.getStats({ marketingPerson: userId });

  // Get my recent clients
  const myRecentClients = await Client.find({
    marketingPerson: userId,
    isActive: true,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate("event", "name");

  // Get pending follow-ups (next 7 days)
  const pendingFollowUps = await Client.find({
    marketingPerson: userId,
    isActive: true,
    followUpStatus: { $nin: ["converted", "lost"] },
    nextFollowUpDate: {
      $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      $gte: new Date(),
    },
  })
    .sort({ nextFollowUpDate: 1 })
    .limit(10)
    .populate("event", "name");

  // Get overdue follow-ups
  const overdueFollowUps = await Client.find({
    marketingPerson: userId,
    isActive: true,
    followUpStatus: { $nin: ["converted", "lost"] },
    nextFollowUpDate: { $lt: new Date() },
  })
    .sort({ nextFollowUpDate: 1 })
    .populate("event", "name");

  // Get clients by event
  const clientsByEvent = await Client.aggregate([
    { $match: { marketingPerson: userId, isActive: true } },
    {
      $group: {
        _id: "$event",
        count: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "events",
        localField: "_id",
        foreignField: "_id",
        as: "event",
      },
    },
    { $unwind: "$event" },
    {
      $project: {
        name: "$event.name",
        count: 1,
        converted: 1,
      },
    },
    { $sort: { count: -1 } },
  ]);

  // Get my weekly trend (last 4 weeks)
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  const weeklyTrend = await Client.aggregate([
    {
      $match: {
        marketingPerson: userId,
        createdAt: { $gte: fourWeeksAgo },
      },
    },
    {
      $group: {
        _id: { $week: "$createdAt" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Get my recent activity
  const myActivity = await ActivityLog.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(15);

  const dashboardData = {
    clientStats,
    myRecentClients,
    pendingFollowUps,
    overdueFollowUps,
    clientsByEvent,
    weeklyTrend,
    myActivity,
  };

  // Cache result
  await setCache(cacheKey, dashboardData, CACHE_TTL);

  successResponse(res, dashboardData);
});

/**
 * @desc    Get dashboard analytics
 * @route   GET /api/dashboard/analytics
 * @access  Private/Admin
 */
const getAnalytics = asyncHandler(async (req, res, next) => {
  const { startDate, endDate, eventId, marketerId } = req.query;

  const matchStage = { isActive: true };

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  if (eventId) matchStage.event = eventId;
  if (marketerId) matchStage.marketingPerson = marketerId;

  // Status distribution
  const statusDistribution = await Client.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$followUpStatus",
        count: { $sum: 1 },
        value: { $sum: "$estimatedValue" },
      },
    },
  ]);

  // Priority distribution
  const priorityDistribution = await Client.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$priority",
        count: { $sum: 1 },
      },
    },
  ]);

  // Source distribution
  const sourceDistribution = await Client.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$source",
        count: { $sum: 1 },
      },
    },
  ]);

  // Daily trend
  const dailyTrend = await Client.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        count: { $sum: 1 },
        converted: {
          $sum: { $cond: [{ $eq: ["$followUpStatus", "converted"] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 30 },
  ]);

  // Average conversion time (for converted clients)
  const conversionTime = await Client.aggregate([
    {
      $match: {
        ...matchStage,
        followUpStatus: "converted",
        convertedDate: { $exists: true },
      },
    },
    {
      $project: {
        conversionDays: {
          $divide: [
            { $subtract: ["$convertedDate", "$createdAt"] },
            1000 * 60 * 60 * 24,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        avgDays: { $avg: "$conversionDays" },
        minDays: { $min: "$conversionDays" },
        maxDays: { $max: "$conversionDays" },
      },
    },
  ]);

  successResponse(res, {
    statusDistribution,
    priorityDistribution,
    sourceDistribution,
    dailyTrend,
    conversionTime: conversionTime[0] || { avgDays: 0, minDays: 0, maxDays: 0 },
  });
});

export { getAdminDashboard, getMarketingDashboard, getAnalytics };
