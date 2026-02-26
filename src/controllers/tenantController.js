import mongoose from "mongoose";
import Tenant from "../models/Tenant.js";
import User from "../models/User.js";
import AuthService from "../core/auth/AuthService.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";

const normalizeSlug = (value = "") =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const bootstrapTenant = asyncHandler(async (req, res, next) => {
  const {
    tenantName,
    slug,
    adminName,
    adminEmail,
    adminPassword,
    companyName,
    companyRef,
  } = req.body;
  const tenantSlug = normalizeSlug(slug || tenantName);

  if (!tenantSlug || tenantSlug.length < 2) {
    return next(ApiError.badRequest("A valid tenant slug is required"));
  }

  const existingTenant = await Tenant.findOne({ slug: tenantSlug }).lean();
  if (existingTenant) {
    return next(ApiError.conflict("Tenant slug already exists"));
  }

  let createdTenant = null;
  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      const createdTenants = await Tenant.create(
        [
          {
            name: tenantName,
            slug: tenantSlug,
            company: {
              name: companyName || undefined,
              referenceId: companyRef || undefined,
            },
            plan: "free",
            isActive: true,
            activeUsers: 1,
          },
        ],
        { session: dbSession },
      );
      createdTenant = createdTenants[0];

      await User.create(
        [
          {
            tenantId: createdTenant._id,
            name: adminName,
            email: String(adminEmail || "").trim().toLowerCase(),
            password: adminPassword,
            role: "admin",
            isActive: true,
            approvalStatus: "approved",
          },
        ],
        { session: dbSession },
      );
    });
  } catch (error) {
    await dbSession.endSession();
    return next(ApiError.badRequest(error.message || "Failed to bootstrap tenant"));
  }

  await dbSession.endSession();

  const authResult = await AuthService.login(adminEmail, adminPassword, {
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
    tenantSlug,
  });

  res.cookie("accessToken", authResult.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refreshToken", authResult.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  successResponse(
    res,
    {
      tenant: {
        id: createdTenant._id,
        name: createdTenant.name,
        slug: createdTenant.slug,
        company: createdTenant.company,
        plan: createdTenant.plan,
        activeUsers: createdTenant.activeUsers,
      },
      user: authResult.user,
    },
    "Tenant bootstrapped successfully",
    201,
  );
});

const getTenants = asyncHandler(async (req, res) => {
  if (req.user.role === "superadmin") {
    const tenants = await Tenant.find({})
      .sort({ createdAt: -1 })
      .select(
        "name slug company plan activeUsers isActive settings subscription createdAt",
      );
    return successResponse(res, { tenants });
  }

  const tenant = await Tenant.findById(req.user.tenantId).select(
    "name slug company plan activeUsers isActive settings subscription createdAt",
  );
  if (!tenant) {
    throw ApiError.notFound("Tenant not found");
  }
  return successResponse(res, { tenants: [tenant] });
});

const getTenantById = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === "superadmin";

  if (!isSuperAdmin && String(req.user.tenantId) !== String(id)) {
    return next(ApiError.forbidden("You can only access your own tenant"));
  }

  const tenant = await Tenant.findById(id).select(
    "name slug company plan activeUsers isActive settings subscription createdAt updatedAt",
  );

  if (!tenant) {
    return next(ApiError.notFound("Tenant not found"));
  }

  successResponse(res, { tenant });
});

const updateTenantById = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === "superadmin";

  if (!isSuperAdmin && String(req.user.tenantId) !== String(id)) {
    return next(ApiError.forbidden("You can only update your own tenant"));
  }

  const update = {};
  const allowedForAdmin = ["name", "company", "settings"];
  const allowedForSuperAdmin = [...allowedForAdmin, "plan", "isActive"];
  const allowedKeys = isSuperAdmin ? allowedForSuperAdmin : allowedForAdmin;

  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      update[key] = req.body[key];
    }
  }

  if (!Object.keys(update).length) {
    return next(ApiError.badRequest("No valid tenant fields provided"));
  }

  const tenant = await Tenant.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  }).select(
    "name slug company plan activeUsers isActive settings subscription updatedAt",
  );

  if (!tenant) {
    return next(ApiError.notFound("Tenant not found"));
  }

  successResponse(res, { tenant }, "Tenant updated successfully");
});

export { bootstrapTenant, getTenants, getTenantById, updateTenantById };
