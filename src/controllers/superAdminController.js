import mongoose from "mongoose";
import Tenant from "../models/Tenant.js";
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Event from "../models/Event.js";
import Client from "../models/Client.js";
import Website from "../models/Website.js";
import ActivityLog from "../models/ActivityLog.js";
import UserSession from "../models/UserSession.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

const isProtectedPlatformOwner = async (user) => {
  if (!user || user.role !== "superadmin") return false;
  const tenant = await Tenant.findById(user.tenantId).select("slug").lean();
  return tenant?.slug === "__platform__";
};

// ─── Platform Overview Dashboard ─────────────────────────────────────────────

/**
 * @desc    Get platform-wide statistics for superadmin dashboard
 * @route   GET /api/superadmin/dashboard
 * @access  Private (superadmin)
 */
const getPlatformDashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalTenants,
    activeTenants,
    totalUsers,
    activeUsers,
    totalLeads,
    totalClients,
    totalEvents,
    totalWebsites,
    tenantsThisMonth,
    usersThisMonth,
    leadsThisMonth,
    activeSessions,
    tenantsByPlan,
    leadsOverTime,
    topTenants,
  ] = await Promise.all([
    Tenant.countDocuments(),
    Tenant.countDocuments({ isActive: true }),
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Lead.countDocuments(),
    Client.countDocuments(),
    Event.countDocuments(),
    Website.countDocuments(),
    Tenant.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Lead.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    UserSession.countDocuments({ isActive: true }),
    // Tenants grouped by plan
    Tenant.aggregate([{ $group: { _id: "$plan", count: { $sum: 1 } } }]),
    // Leads created per day (last 30 days)
    Lead.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Top 10 tenants by lead count
    Lead.aggregate([
      {
        $group: {
          _id: "$tenantId",
          leadCount: { $sum: 1 },
        },
      },
      { $sort: { leadCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "tenants",
          localField: "_id",
          foreignField: "_id",
          as: "tenant",
        },
      },
      { $unwind: "$tenant" },
      {
        $project: {
          _id: 1,
          leadCount: 1,
          tenantName: "$tenant.name",
          tenantSlug: "$tenant.slug",
          plan: "$tenant.plan",
          isActive: "$tenant.isActive",
        },
      },
    ]),
  ]);

  successResponse(res, {
    overview: {
      totalTenants,
      activeTenants,
      inactiveTenants: totalTenants - activeTenants,
      totalUsers,
      activeUsers,
      totalLeads,
      totalClients,
      totalEvents,
      totalWebsites,
      activeSessions,
    },
    growth: {
      tenantsThisMonth,
      usersThisMonth,
      leadsThisMonth,
    },
    tenantsByPlan: tenantsByPlan.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    leadsOverTime,
    topTenants,
  });
});

// ─── Tenant Management ───────────────────────────────────────────────────────

/**
 * @desc    List all tenants with stats
 * @route   GET /api/superadmin/tenants
 * @access  Private (superadmin)
 */
const getAllTenants = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    plan,
    isActive,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  const query = {};

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { slug: { $regex: search, $options: "i" } },
      { "company.name": { $regex: search, $options: "i" } },
    ];
  }
  if (plan) query.plan = plan;
  if (isActive !== undefined) query.isActive = isActive === "true";

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  const [tenants, total] = await Promise.all([
    Tenant.find(query).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
    Tenant.countDocuments(query),
  ]);

  // Enrich each tenant with aggregated stats
  const enrichedTenants = await Promise.all(
    tenants.map(async (tenant) => {
      const [userCount, leadCount, clientCount, eventCount, websiteCount] =
        await Promise.all([
          User.countDocuments({ tenantId: tenant._id }),
          Lead.countDocuments({ tenantId: tenant._id }),
          Client.countDocuments({ tenantId: tenant._id }),
          Event.countDocuments({ tenantId: tenant._id }),
          Website.countDocuments({ tenantId: tenant._id }),
        ]);

      return {
        ...tenant,
        stats: { userCount, leadCount, clientCount, eventCount, websiteCount },
      };
    }),
  );

  successResponse(res, {
    tenants: enrichedTenants,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * @desc    Get single tenant with full details
 * @route   GET /api/superadmin/tenants/:id
 * @access  Private (superadmin)
 */
const getTenantDetail = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const [users, leads, clients, events, websites, recentActivity] =
    await Promise.all([
      User.find({ tenantId: tenant._id })
        .select(
          "-password -refreshToken -passwordResetToken -passwordResetExpires",
        )
        .sort({ createdAt: -1 })
        .lean(),
      Lead.countDocuments({ tenantId: tenant._id }),
      Client.countDocuments({ tenantId: tenant._id }),
      Event.find({ tenantId: tenant._id })
        .select("name status startDate endDate")
        .sort({ startDate: -1 })
        .limit(10)
        .lean(),
      Website.find({ tenantId: tenant._id })
        .select("name domain category isActive stats")
        .lean(),
      ActivityLog.find({ tenantId: tenant._id })
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

  successResponse(res, {
    tenant,
    users,
    stats: {
      userCount: users.length,
      leadCount: leads,
      clientCount: clients,
      eventCount: events.length,
      websiteCount: websites.length,
    },
    events,
    websites,
    recentActivity,
  });
});

/**
 * @desc    Create a new tenant (superadmin can provision workspaces)
 * @route   POST /api/superadmin/tenants
 * @access  Private (superadmin)
 */
const createTenant = asyncHandler(async (req, res, next) => {
  const {
    name,
    slug,
    companyName,
    companyRef,
    plan,
    adminName,
    adminEmail,
    adminPassword,
    settings,
  } = req.body;

  const normalizedSlug = String(slug || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalizedSlug || normalizedSlug.length < 2) {
    return next(ApiError.badRequest("A valid slug is required"));
  }

  const existing = await Tenant.findOne({ slug: normalizedSlug }).lean();
  if (existing) return next(ApiError.conflict("Tenant slug already exists"));

  const dbSession = await mongoose.startSession();
  let createdTenant = null;

  try {
    await dbSession.withTransaction(async () => {
      const [tenant] = await Tenant.create(
        [
          {
            name,
            slug: normalizedSlug,
            company: { name: companyName, referenceId: companyRef },
            plan: plan || "free",
            isActive: true,
            activeUsers: adminEmail ? 1 : 0,
            settings: settings || {},
          },
        ],
        { session: dbSession },
      );
      createdTenant = tenant;

      if (adminEmail && adminPassword) {
        await User.create(
          [
            {
              tenantId: tenant._id,
              name: adminName || "Workspace Admin",
              email: String(adminEmail).trim().toLowerCase(),
              password: adminPassword,
              role: "admin",
              isActive: true,
              approvalStatus: "approved",
            },
          ],
          { session: dbSession },
        );
      }
    });
  } catch (error) {
    await dbSession.endSession();
    return next(ApiError.badRequest(error.message));
  }

  await dbSession.endSession();

  successResponse(
    res,
    { tenant: createdTenant },
    "Tenant created successfully",
    201,
  );
});

/**
 * @desc    Update any tenant (plan, status, settings, etc.)
 * @route   PUT /api/superadmin/tenants/:id
 * @access  Private (superadmin)
 */
const updateTenant = asyncHandler(async (req, res, next) => {
  const allowed = [
    "name",
    "company",
    "plan",
    "isActive",
    "settings",
    "allowedRoles",
  ];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }

  if (!Object.keys(update).length) {
    return next(ApiError.badRequest("No valid fields provided"));
  }

  const existingTenant = await Tenant.findById(req.params.id).select("slug");
  if (!existingTenant) return next(ApiError.notFound("Tenant not found"));

  if (existingTenant.slug === "__platform__" && update.isActive === false) {
    return next(
      ApiError.forbidden("Platform tenant cannot be deactivated or deleted"),
    );
  }

  const tenant = await Tenant.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  });

  logger.info(
    `SuperAdmin updated tenant ${tenant.slug}: ${JSON.stringify(update)}`,
  );

  successResponse(res, { tenant }, "Tenant updated");
});

/**
 * @desc    Delete / deactivate a tenant
 * @route   DELETE /api/superadmin/tenants/:id
 * @access  Private (superadmin)
 */
const deleteTenant = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  if (tenant.slug === "__platform__") {
    return next(ApiError.forbidden("Platform tenant cannot be deleted"));
  }

  // Soft-delete: deactivate (hard-delete is dangerous)
  tenant.isActive = false;
  await tenant.save();

  // Deactivate all users in that tenant
  await User.updateMany({ tenantId: tenant._id }, { isActive: false });

  logger.warn(`SuperAdmin deactivated tenant ${tenant.slug} and all its users`);

  successResponse(res, null, "Tenant deactivated");
});

// ─── User Management (Cross-Tenant) ─────────────────────────────────────────

/**
 * @desc    List all users across all tenants
 * @route   GET /api/superadmin/users
 * @access  Private (superadmin)
 */
const getAllUsers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 25,
    search,
    role,
    isActive,
    tenantId,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  const query = {};
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }
  if (role) query.role = role;
  if (isActive !== undefined) query.isActive = isActive === "true";
  if (tenantId) query.tenantId = tenantId;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  const [users, total] = await Promise.all([
    User.find(query)
      .select(
        "-password -refreshToken -passwordResetToken -passwordResetExpires",
      )
      .populate("tenantId", "name slug plan isActive")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    User.countDocuments(query),
  ]);

  const usersWithProtection = users.map((u) => ({
    ...u,
    isProtected:
      u?.role === "superadmin" && u?.tenantId?.slug === "__platform__",
  }));

  successResponse(res, {
    users: usersWithProtection,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * @desc    Toggle user active status from superadmin panel
 * @route   PUT /api/superadmin/users/:id/toggle-active
 * @access  Private (superadmin)
 */
const toggleUserActive = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id).select(
    "-password -refreshToken",
  );
  if (!user) return next(ApiError.notFound("User not found"));

  if (await isProtectedPlatformOwner(user)) {
    return next(
      ApiError.forbidden("Platform Owner account is protected and immutable"),
    );
  }

  user.isActive = !user.isActive;
  await user.save();

  logger.info(
    `SuperAdmin ${user.isActive ? "activated" : "deactivated"} user ${user.email}`,
  );

  successResponse(
    res,
    { user },
    `User ${user.isActive ? "activated" : "deactivated"}`,
  );
});

/**
 * @desc    Change user's role from superadmin panel
 * @route   PUT /api/superadmin/users/:id/role
 * @access  Private (superadmin)
 */
const changeUserRole = asyncHandler(async (req, res, next) => {
  const { role } = req.body;
  const validRoles = ["admin", "marketing", "user"];

  if (!validRoles.includes(role)) {
    return next(ApiError.badRequest("Invalid role"));
  }

  const user = await User.findById(req.params.id).select(
    "-password -refreshToken",
  );
  if (!user) return next(ApiError.notFound("User not found"));

  if (await isProtectedPlatformOwner(user)) {
    return next(
      ApiError.forbidden("Platform Owner permissions cannot be changed"),
    );
  }

  user.role = role;
  await user.save();

  logger.info(`SuperAdmin changed role of ${user.email} to ${role}`);

  successResponse(res, { user }, `Role updated to ${role}`);
});

// ─── Platform Activity ───────────────────────────────────────────────────────

/**
 * @desc    List recent activity across the entire platform
 * @route   GET /api/superadmin/activity
 * @access  Private (superadmin)
 */
const getPlatformActivity = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, action, tenantId } = req.query;

  const query = {};
  if (action) query.action = action;
  if (tenantId) query.tenantId = tenantId;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [logs, total] = await Promise.all([
    ActivityLog.find(query)
      .populate("user", "name email role")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    ActivityLog.countDocuments(query),
  ]);

  successResponse(res, {
    logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
});

export {
  getPlatformDashboard,
  getAllTenants,
  getTenantDetail,
  createTenant,
  updateTenant,
  deleteTenant,
  getAllUsers,
  toggleUserActive,
  changeUserRole,
  getPlatformActivity,
};
