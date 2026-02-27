import mongoose from "mongoose";
import Deal from "../../models/crm/Deal.js";
import Lead from "../../models/Lead.js";
import Contact from "../../models/crm/Contact.js";
import CrmActivity from "../../models/crm/CrmActivity.js";

/**
 * CrmAnalyticsService — Pre-built aggregation pipelines for CRM reporting.
 * Uses MongoDB aggregation + indexes. No heavy computation per-request.
 */
const CrmAnalyticsService = {
  /**
   * Deal Funnel — counts and total amounts per stage for a pipeline.
   */
  async dealFunnel(tenantId, pipelineId) {
    return Deal.aggregate([
      {
        $match: {
          tenantId: toObjectId(tenantId),
          pipelineId: toObjectId(pipelineId),
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: "$stage",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgProbability: { $avg: "$probability" },
        },
      },
      { $sort: { avgProbability: 1 } },
      {
        $project: {
          stage: "$_id",
          count: 1,
          totalAmount: 1,
          avgProbability: { $round: ["$avgProbability", 1] },
          _id: 0,
        },
      },
    ]);
  },

  /**
   * Lead Source Performance — conversion rate by source.
   */
  async leadSourcePerformance(tenantId) {
    return Lead.aggregate([
      {
        $match: {
          tenantId: toObjectId(tenantId),
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: "$source",
          totalLeads: { $sum: 1 },
          convertedLeads: {
            $sum: { $cond: [{ $eq: ["$isConverted", true] }, 1, 0] },
          },
          totalValue: {
            $sum: {
              $cond: [{ $eq: ["$isConverted", true] }, "$conversionValue", 0],
            },
          },
        },
      },
      {
        $project: {
          source: "$_id",
          totalLeads: 1,
          convertedLeads: 1,
          conversionRate: {
            $round: [
              {
                $multiply: [
                  {
                    $cond: [
                      { $eq: ["$totalLeads", 0] },
                      0,
                      { $divide: ["$convertedLeads", "$totalLeads"] },
                    ],
                  },
                  100,
                ],
              },
              1,
            ],
          },
          totalValue: 1,
          _id: 0,
        },
      },
      { $sort: { conversionRate: -1 } },
    ]);
  },

  /**
   * Owner Performance — deals won/lost, revenue, and activity count per user.
   */
  async ownerPerformance(tenantId, { startDate, endDate } = {}) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const matchStage = {
      tenantId: toObjectId(tenantId),
      deletedAt: null,
    };
    if (startDate || endDate) matchStage.createdAt = dateFilter;

    const [dealStats, activityStats] = await Promise.all([
      Deal.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: "$ownerId",
            totalDeals: { $sum: 1 },
            wonDeals: { $sum: { $cond: [{ $ne: ["$wonAt", null] }, 1, 0] } },
            lostDeals: { $sum: { $cond: [{ $ne: ["$lostAt", null] }, 1, 0] } },
            openDeals: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$wonAt", null] },
                      { $eq: ["$lostAt", null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            totalRevenue: {
              $sum: { $cond: [{ $ne: ["$wonAt", null] }, "$amount", 0] },
            },
            totalPipeline: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$wonAt", null] },
                      { $eq: ["$lostAt", null] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "owner",
          },
        },
        { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            ownerId: "$_id",
            ownerName: "$owner.name",
            ownerEmail: "$owner.email",
            totalDeals: 1,
            wonDeals: 1,
            lostDeals: 1,
            openDeals: 1,
            totalRevenue: 1,
            totalPipeline: 1,
            winRate: {
              $round: [
                {
                  $cond: [
                    { $eq: [{ $add: ["$wonDeals", "$lostDeals"] }, 0] },
                    0,
                    {
                      $multiply: [
                        {
                          $divide: [
                            "$wonDeals",
                            { $add: ["$wonDeals", "$lostDeals"] },
                          ],
                        },
                        100,
                      ],
                    },
                  ],
                },
                1,
              ],
            },
            _id: 0,
          },
        },
        { $sort: { totalRevenue: -1 } },
      ]),

      CrmActivity.aggregate([
        {
          $match: {
            tenantId: toObjectId(tenantId),
            deletedAt: null,
            ...(startDate || endDate ? { createdAt: dateFilter } : {}),
          },
        },
        {
          $group: {
            _id: "$ownerId",
            totalActivities: { $sum: 1 },
            completedActivities: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    // Merge activity stats into deal stats
    const activityMap = new Map(activityStats.map((a) => [String(a._id), a]));
    return dealStats.map((d) => {
      const acts = activityMap.get(String(d.ownerId)) || {};
      return {
        ...d,
        totalActivities: acts.totalActivities || 0,
        completedActivities: acts.completedActivities || 0,
      };
    });
  },

  /**
   * Stage Duration — average time spent in each deal stage.
   */
  async stageDuration(tenantId, pipelineId) {
    return Deal.aggregate([
      {
        $match: {
          tenantId: toObjectId(tenantId),
          pipelineId: toObjectId(pipelineId),
          deletedAt: null,
        },
      },
      { $unwind: "$stageHistory" },
      {
        $match: {
          "stageHistory.durationMs": { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$stageHistory.stage",
          avgDurationMs: { $avg: "$stageHistory.durationMs" },
          minDurationMs: { $min: "$stageHistory.durationMs" },
          maxDurationMs: { $max: "$stageHistory.durationMs" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          stage: "$_id",
          avgDurationHours: {
            $round: [{ $divide: ["$avgDurationMs", 3600000] }, 1],
          },
          minDurationHours: {
            $round: [{ $divide: ["$minDurationMs", 3600000] }, 1],
          },
          maxDurationHours: {
            $round: [{ $divide: ["$maxDurationMs", 3600000] }, 1],
          },
          count: 1,
          _id: 0,
        },
      },
      { $sort: { avgDurationHours: 1 } },
    ]);
  },

  /**
   * Summary snapshot — quick numbers for dashboard.
   */
  async snapshot(tenantId) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);

    const [dealSummary, contactCount, leadStats] = await Promise.all([
      Deal.aggregate([
        { $match: { tenantId: toObjectId(tenantId), deletedAt: null } },
        {
          $group: {
            _id: null,
            totalDeals: { $sum: 1 },
            openPipeline: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$wonAt", null] },
                      { $eq: ["$lostAt", null] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            wonRevenue: {
              $sum: { $cond: [{ $ne: ["$wonAt", null] }, "$amount", 0] },
            },
            wonThisMonth: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$wonAt", null] },
                      { $gte: ["$wonAt", thirtyDaysAgo] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      Contact.countDocuments({
        tenantId: toObjectId(tenantId),
        deletedAt: null,
      }),
      Lead.aggregate([
        { $match: { tenantId: toObjectId(tenantId), deletedAt: null } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            converted: {
              $sum: { $cond: [{ $eq: ["$isConverted", true] }, 1, 0] },
            },
            newThisMonth: {
              $sum: { $cond: [{ $gte: ["$createdAt", thirtyDaysAgo] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    const ds = dealSummary[0] || {};
    const ls = leadStats[0] || {};

    return {
      deals: {
        total: ds.totalDeals || 0,
        openPipeline: ds.openPipeline || 0,
        wonRevenue: ds.wonRevenue || 0,
        wonThisMonth: ds.wonThisMonth || 0,
      },
      contacts: contactCount,
      leads: {
        total: ls.total || 0,
        converted: ls.converted || 0,
        newThisMonth: ls.newThisMonth || 0,
      },
    };
  },
};

/**
 * Helper to safely convert string to ObjectId for aggregation.
 */
function toObjectId(id) {
  return typeof id === "string" ? new mongoose.Types.ObjectId(id) : id;
}

export default CrmAnalyticsService;
