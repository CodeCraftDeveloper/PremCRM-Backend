import mongoose from "mongoose";
import Tenant from "../models/Tenant.js";
import User from "../models/User.js";
import Lead from "../models/Lead.js";
import Event from "../models/Event.js";
import Client from "../models/Client.js";
import Website from "../models/Website.js";
import ActivityLog from "../models/ActivityLog.js";
import UserSession from "../models/UserSession.js";
import AuditLog from "../models/AuditLog.js";
import UsageMetric from "../models/UsageMetric.js";
import TenantSettings from "../models/TenantSettings.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

const PLATFORM_TENANT_SLUG = "__platform__";

const isProtectedPlatformOwner = async (user) => {
  if (!user || user.role !== "superadmin") return false;
  const tenant = await Tenant.findById(user.tenantId).select("slug").lean();
  return tenant?.slug === PLATFORM_TENANT_SLUG;
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
  const platformTenant = await Tenant.findOne({ slug: PLATFORM_TENANT_SLUG })
    .select("_id")
    .lean();
  const platformTenantId = platformTenant?._id || null;
  const tenantFilter = { slug: { $ne: PLATFORM_TENANT_SLUG } };
  const userFilter = platformTenantId
    ? { tenantId: { $ne: platformTenantId } }
    : {};
  const userActiveFilter = {
    ...userFilter,
    isActive: true,
  };

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
    Tenant.countDocuments(tenantFilter),
    Tenant.countDocuments({ ...tenantFilter, isActive: true }),
    User.countDocuments(userFilter),
    User.countDocuments(userActiveFilter),
    Lead.countDocuments(),
    Client.countDocuments(),
    Event.countDocuments(),
    Website.countDocuments(),
    Tenant.countDocuments({
      ...tenantFilter,
      createdAt: { $gte: thirtyDaysAgo },
    }),
    User.countDocuments({ ...userFilter, createdAt: { $gte: thirtyDaysAgo } }),
    Lead.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    UserSession.countDocuments({ isActive: true }),
    // Tenants grouped by plan
    Tenant.aggregate([
      { $match: tenantFilter },
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]),
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
      { $match: { "tenant.slug": { $ne: PLATFORM_TENANT_SLUG } } },
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

  // Update tenant lastActivityAt in background (non-blocking)
  setImmediate(async () => {
    try {
      const tenants = await Tenant.find({ ...tenantFilter, isActive: true })
        .select("_id")
        .lean();
      for (const t of tenants) {
        const lastSession = await UserSession.findOne({ tenantId: t._id })
          .sort({ loginTime: -1 })
          .select("loginTime")
          .lean();
        if (lastSession?.loginTime) {
          await Tenant.updateOne(
            { _id: t._id },
            { $set: { lastActivityAt: lastSession.loginTime } },
          );
        }
      }
    } catch (err) {
      logger.error("Failed to update tenant lastActivityAt", err);
    }
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

  const query = { slug: { $ne: PLATFORM_TENANT_SLUG } };

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
  if (tenant.slug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.notFound("Tenant not found"));
  }

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
  if (normalizedSlug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.forbidden("This slug is reserved"));
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

  if (
    existingTenant.slug === PLATFORM_TENANT_SLUG &&
    update.isActive === false
  ) {
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

  if (tenant.slug === PLATFORM_TENANT_SLUG) {
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
      u?.role === "superadmin" && u?.tenantId?.slug === PLATFORM_TENANT_SLUG,
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

/**
 * @desc    Set user password from superadmin panel
 * @route   PUT /api/superadmin/users/:id/password
 * @access  Private (superadmin)
 */
const changeUserPassword = asyncHandler(async (req, res, next) => {
  const { newPassword } = req.body;

  const user = await User.findById(req.params.id).select("+password");
  if (!user) return next(ApiError.notFound("User not found"));

  if (await isProtectedPlatformOwner(user)) {
    return next(
      ApiError.forbidden("Platform Owner password cannot be changed here"),
    );
  }

  user.password = newPassword;
  user.refreshToken = null;
  await user.save();

  await UserSession.updateMany(
    { user: user._id, isActive: true },
    { isActive: false, logoutTime: new Date() },
  );

  AuditLog.record({
    tenantId: user.tenantId,
    userId: req.user._id,
    action: "user.password_reset_by_superadmin",
    entityType: "user",
    entityId: user._id,
    description: `SuperAdmin reset password for ${user.email}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  successResponse(
    res,
    { userId: user._id },
    "User password updated successfully",
  );
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

// ─── Suspend Tenant ──────────────────────────────────────────────────────────

/**
 * @desc    Suspend a tenant (deactivate + mark suspended)
 * @route   POST /api/superadmin/tenants/:id/suspend
 * @access  Private (superadmin)
 */
const suspendTenant = asyncHandler(async (req, res, next) => {
  const { reason } = req.body;
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return next(ApiError.notFound("Tenant not found"));
  if (tenant.slug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.forbidden("Platform tenant cannot be suspended"));
  }
  if (!tenant.isActive) {
    return next(ApiError.badRequest("Tenant is already suspended"));
  }

  tenant.isActive = false;
  tenant.suspendedAt = new Date();
  tenant.suspendedBy = req.user._id;
  tenant.suspendReason = reason || null;
  await tenant.save();

  // Deactivate all tenant users
  await User.updateMany({ tenantId: tenant._id }, { isActive: false });

  // End all active sessions
  await UserSession.updateMany(
    { tenantId: tenant._id, isActive: true },
    { isActive: false, logoutTime: new Date() },
  );

  // Audit log
  AuditLog.record({
    tenantId: tenant._id,
    userId: req.user._id,
    action: "tenant.suspend",
    entityType: "tenant",
    entityId: tenant._id,
    description: `Tenant ${tenant.slug} suspended. Reason: ${reason || "N/A"}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.warn(`SuperAdmin suspended tenant ${tenant.slug}`);
  successResponse(res, { tenant }, "Tenant suspended");
});

// ─── Reactivate Tenant ───────────────────────────────────────────────────────

/**
 * @desc    Reactivate a suspended tenant
 * @route   POST /api/superadmin/tenants/:id/reactivate
 * @access  Private (superadmin)
 */
const reactivateTenant = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return next(ApiError.notFound("Tenant not found"));
  if (tenant.slug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.forbidden("Platform tenant cannot be modified"));
  }
  if (tenant.isActive) {
    return next(ApiError.badRequest("Tenant is already active"));
  }

  tenant.isActive = true;
  tenant.suspendedAt = null;
  tenant.suspendedBy = null;
  tenant.suspendReason = null;
  await tenant.save();

  // Reactivate admin users (other users remain deactivated for safety)
  await User.updateMany(
    { tenantId: tenant._id, role: "admin" },
    { isActive: true },
  );

  AuditLog.record({
    tenantId: tenant._id,
    userId: req.user._id,
    action: "tenant.reactivate",
    entityType: "tenant",
    entityId: tenant._id,
    description: `Tenant ${tenant.slug} reactivated`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`SuperAdmin reactivated tenant ${tenant.slug}`);
  successResponse(res, { tenant }, "Tenant reactivated");
});

// ─── Tenant Health ───────────────────────────────────────────────────────────

/**
 * @desc    Get tenant health overview
 * @route   GET /api/superadmin/tenants/:id/health
 * @access  Private (superadmin)
 */
const getTenantHealth = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));
  if (tenant.slug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.notFound("Tenant not found"));
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    activeUsers,
    totalUsers,
    activeSessions,
    leadsTotal,
    leads7d,
    clients7d,
    lastSession,
    storageEstimate,
  ] = await Promise.all([
    User.countDocuments({ tenantId: tenant._id, isActive: true }),
    User.countDocuments({ tenantId: tenant._id }),
    UserSession.countDocuments({ tenantId: tenant._id, isActive: true }),
    Lead.countDocuments({ tenantId: tenant._id, deletedAt: null }),
    Lead.countDocuments({
      tenantId: tenant._id,
      deletedAt: null,
      createdAt: { $gte: sevenDaysAgo },
    }),
    Client.countDocuments({
      tenantId: tenant._id,
      isActive: true,
      createdAt: { $gte: sevenDaysAgo },
    }),
    UserSession.findOne({ tenantId: tenant._id })
      .sort({ loginTime: -1 })
      .select("loginTime")
      .lean(),
    // Rough storage estimate based on lead + client count * average doc size
    Lead.countDocuments({ tenantId: tenant._id }).then((c) => c * 2048), // ~2KB per lead
  ]);

  successResponse(res, {
    tenant: {
      _id: tenant._id,
      name: tenant.name,
      slug: tenant.slug,
      plan: tenant.plan,
      isActive: tenant.isActive,
      suspendedAt: tenant.suspendedAt,
    },
    health: {
      activeUsers,
      totalUsers,
      activeSessions,
      leadsTotal,
      leadsLast7Days: leads7d,
      clientsLast7Days: clients7d,
      lastActivity: lastSession?.loginTime || tenant.updatedAt,
      estimatedStorageBytes: storageEstimate,
    },
  });
});

// ─── Force Logout All Tenant Users ───────────────────────────────────────────

/**
 * @desc    Force logout all users in a tenant
 * @route   POST /api/superadmin/tenants/:id/force-logout
 * @access  Private (superadmin)
 */
const forceLogoutTenant = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return next(ApiError.notFound("Tenant not found"));
  if (tenant.slug === PLATFORM_TENANT_SLUG) {
    return next(ApiError.forbidden("Cannot force logout platform tenant"));
  }

  const result = await UserSession.updateMany(
    { tenantId: tenant._id, isActive: true },
    { isActive: false, logoutTime: new Date() },
  );

  // Clear all refresh tokens for tenant users
  await User.updateMany({ tenantId: tenant._id }, { refreshToken: null });

  AuditLog.record({
    tenantId: tenant._id,
    userId: req.user._id,
    action: "tenant.force_logout",
    entityType: "tenant",
    entityId: tenant._id,
    description: `Force logged out ${result.modifiedCount} sessions for tenant ${tenant.slug}`,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.warn(`SuperAdmin force logged out all users of tenant ${tenant.slug}`);
  successResponse(
    res,
    { sessionsEnded: result.modifiedCount },
    "All tenant users logged out",
  );
});

// ─── Enhanced Dashboard with storage & last activity ─────────────────────────

/**
 * @desc    Get per-tenant usage metrics
 * @route   GET /api/superadmin/tenants/:id/usage
 * @access  Private (superadmin)
 */
const getTenantUsage = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const { days = 30 } = req.query;
  const parsedDays = Math.min(parseInt(days) || 30, 365);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parsedDays);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = new Date().toISOString().slice(0, 10);

  const metrics = await UsageMetric.getRange(
    tenant._id,
    startDateStr,
    endDateStr,
  );

  // Aggregate totals
  const totals = metrics.reduce(
    (acc, m) => {
      acc.leadsCreated += m.leadsCreated || 0;
      acc.apiCalls += m.apiCalls || 0;
      acc.activeUsers += m.activeUsers || 0;
      return acc;
    },
    { leadsCreated: 0, apiCalls: 0, activeUsers: 0 },
  );

  successResponse(res, {
    tenant: { _id: tenant._id, name: tenant.name, slug: tenant.slug },
    period: { startDate: startDateStr, endDate: endDateStr, days: parsedDays },
    totals,
    daily: metrics,
  });
});

// ─── Audit Log Query ─────────────────────────────────────────────────────────

/**
 * @desc    Query audit logs (platform-wide or per-tenant)
 * @route   GET /api/superadmin/audit-logs
 * @access  Private (superadmin)
 */
const getAuditLogs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    tenantId,
    userId,
    action,
    entityType,
    startDate,
    endDate,
  } = req.query;

  const query = {};
  if (tenantId) query.tenantId = tenantId;
  if (userId) query.userId = userId;
  if (action) query.action = action;
  if (entityType) query.entityType = entityType;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [logs, total] = await Promise.all([
    AuditLog.find(query)
      .populate("userId", "name email role")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    AuditLog.countDocuments(query),
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

// ─── Soft Delete Management ──────────────────────────────────────────────────

/**
 * @desc    List soft-deleted leads/clients across a tenant
 * @route   GET /api/superadmin/tenants/:id/deleted
 * @access  Private (superadmin)
 */
const getDeletedRecords = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const { type = "all", page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const results = {};

  if (type === "all" || type === "leads") {
    const [leads, leadsTotal] = await Promise.all([
      Lead.find({ tenantId: tenant._id, deletedAt: { $ne: null } })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select("fullName email status deletedAt deletedBy")
        .populate("deletedBy", "name email")
        .lean(),
      Lead.countDocuments({ tenantId: tenant._id, deletedAt: { $ne: null } }),
    ]);
    results.leads = { data: leads, total: leadsTotal };
  }

  if (type === "all" || type === "clients") {
    const [clients, clientsTotal] = await Promise.all([
      Client.find({ tenantId: tenant._id, deletedAt: { $ne: null } })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select("name email followUpStatus deletedAt deletedBy")
        .populate("deletedBy", "name email")
        .lean(),
      Client.countDocuments({ tenantId: tenant._id, deletedAt: { $ne: null } }),
    ]);
    results.clients = { data: clients, total: clientsTotal };
  }

  successResponse(res, results);
});

/**
 * @desc    Hard delete a lead or client (permanent, superadmin only)
 * @route   DELETE /api/superadmin/hard-delete/:entityType/:entityId
 * @access  Private (superadmin)
 * @query   tenantId (required) - tenant that owns the entity
 * @query   dryRun=true - preview what would be deleted without actually deleting
 * @query   confirm=PERMANENT_DELETE - safety confirmation token
 */
const hardDelete = asyncHandler(async (req, res, next) => {
  const { entityType, entityId } = req.params;
  const { tenantId: targetTenantId, dryRun, confirm } = req.query;

  if (!mongoose.Types.ObjectId.isValid(entityId)) {
    return next(ApiError.badRequest("Invalid entity ID"));
  }

  // SECURITY: Require explicit tenant scoping
  if (!targetTenantId || !mongoose.Types.ObjectId.isValid(targetTenantId)) {
    return next(
      ApiError.badRequest(
        "tenantId query parameter is required for hard delete operations",
      ),
    );
  }

  // Verify the target tenant exists
  const targetTenant = await Tenant.findById(targetTenantId).lean();
  if (!targetTenant) {
    return next(ApiError.notFound("Target tenant not found"));
  }

  // Determine model
  let Model;
  if (entityType === "lead") {
    Model = Lead;
  } else if (entityType === "client") {
    Model = Client;
  } else {
    return next(ApiError.badRequest("Entity type must be 'lead' or 'client'"));
  }

  // SECURITY: Fetch entity with tenant scope to prevent cross-tenant deletion
  const entity = await Model.findOne({
    _id: entityId,
    tenantId: targetTenantId,
  });

  if (!entity) {
    return next(
      ApiError.notFound(`${entityType} not found in the specified tenant`),
    );
  }

  // Dry-run mode: return what would be deleted without performing the operation
  if (dryRun === "true") {
    return successResponse(
      res,
      {
        dryRun: true,
        entityType,
        entityId: entity._id,
        tenantId: targetTenantId,
        tenantName: targetTenant.name,
        entity: {
          id: entity._id,
          name: entity.fullName || entity.name || entity.email,
          deletedAt: entity.deletedAt,
        },
        warning: "This operation is PERMANENT and cannot be undone.",
        confirmInstruction:
          "To execute, add ?confirm=PERMANENT_DELETE to the request",
      },
      "Dry run completed — no changes made",
    );
  }

  // SECURITY: Require confirmation token for actual deletion
  if (confirm !== "PERMANENT_DELETE") {
    return next(
      ApiError.badRequest(
        "Safety check: add ?confirm=PERMANENT_DELETE to confirm permanent deletion. Use ?dryRun=true to preview.",
      ),
    );
  }

  // Perform the deletion
  await Model.findByIdAndDelete(entityId);

  // Full audit trail
  AuditLog.record({
    tenantId: entity.tenantId,
    userId: req.user._id,
    action: `${entityType}.hard_delete`,
    entityType,
    entityId: entity._id,
    description: `Permanently deleted ${entityType} ${entity._id} from tenant ${targetTenant.name} (${targetTenantId})`,
    metadata: {
      entityName: entity.fullName || entity.name || entity.email,
      targetTenantId,
      targetTenantName: targetTenant.name,
      confirmedBy: req.user._id,
    },
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.warn(
    `SuperAdmin ${req.user._id} hard-deleted ${entityType} ${entityId} from tenant ${targetTenantId}`,
  );
  successResponse(res, null, `${entityType} permanently deleted`);
});

// ─── Tenant Settings Management ──────────────────────────────────────────────

/**
 * @desc    Get tenant settings
 * @route   GET /api/superadmin/tenants/:id/settings
 * @access  Private (superadmin)
 */
const getTenantSettings = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const settings = await TenantSettings.getForTenant(tenant._id);
  successResponse(res, { tenantId: tenant._id, settings });
});

/**
 * @desc    Update tenant settings
 * @route   PUT /api/superadmin/tenants/:id/settings
 * @access  Private (superadmin)
 */
const updateTenantSettings = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const allowed = [
    "leadStatusPipeline",
    "customFields",
    "sla",
    "assignmentRules",
    "features",
  ];

  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      update[key] = req.body[key];
    }
  }

  if (!Object.keys(update).length) {
    return next(ApiError.badRequest("No valid settings provided"));
  }

  const settings = await TenantSettings.findOneAndUpdate(
    { tenantId: tenant._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true },
  );

  AuditLog.record({
    tenantId: tenant._id,
    userId: req.user._id,
    action: "settings.update",
    entityType: "settings",
    entityId: settings._id,
    description: `Updated tenant settings for ${tenant.slug}: ${Object.keys(update).join(", ")}`,
    metadata: update,
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  successResponse(res, { settings }, "Tenant settings updated");
});

// ─── Feature Flags ───────────────────────────────────────────────────────────

/**
 * @desc    Update feature flags for a tenant
 * @route   PUT /api/superadmin/tenants/:id/features
 * @access  Private (superadmin)
 */
const updateFeatureFlags = asyncHandler(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return next(ApiError.notFound("Tenant not found"));

  const { features } = req.body;
  if (!features || typeof features !== "object") {
    return next(ApiError.badRequest("Features object is required"));
  }

  const settings = await TenantSettings.findOneAndUpdate(
    { tenantId: tenant._id },
    { $set: { features } },
    { new: true, upsert: true, runValidators: true },
  );

  AuditLog.record({
    tenantId: tenant._id,
    userId: req.user._id,
    action: "feature_flag.update",
    entityType: "settings",
    entityId: settings._id,
    description: `Updated feature flags for ${tenant.slug}`,
    metadata: { features },
    requestId: req.requestId,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  successResponse(
    res,
    { features: settings.features },
    "Feature flags updated",
  );
});

// ─── Index Report ────────────────────────────────────────────────────────────

/**
 * @desc    Generate index report for all collections
 * @route   GET /api/superadmin/index-report
 * @access  Private (superadmin)
 */
const getIndexReport = asyncHandler(async (req, res) => {
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  const report = [];
  for (const col of collections) {
    const indexes = await db.collection(col.name).indexes();
    const stats = await db
      .collection(col.name)
      .stats()
      .catch(() => null);
    report.push({
      collection: col.name,
      indexCount: indexes.length,
      indexes: indexes.map((idx) => ({
        name: idx.name,
        key: idx.key,
        unique: idx.unique || false,
        sparse: idx.sparse || false,
        expireAfterSeconds: idx.expireAfterSeconds || null,
      })),
      documentCount: stats?.count || 0,
      storageSize: stats?.storageSize || 0,
      totalIndexSize: stats?.totalIndexSize || 0,
    });
  }

  successResponse(res, { report });
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
  changeUserPassword,
  getPlatformActivity,
  // New Step 1
  suspendTenant,
  reactivateTenant,
  getTenantHealth,
  forceLogoutTenant,
  // New Step 2
  getAuditLogs,
  // New Step 3
  getTenantUsage,
  // New Step 4
  getDeletedRecords,
  hardDelete,
  // New Step 5 & 6
  getTenantSettings,
  updateTenantSettings,
  updateFeatureFlags,
  // New Step 7
  getIndexReport,
};
