import mongoose from "mongoose";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import Tenant from "../models/Tenant.js";
import User from "../models/User.js";
import AuthService from "../core/auth/AuthService.js";
import { getSignedFileUrl, s3Client, uploadToS3 } from "../config/s3.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";

const PLATFORM_TENANT_SLUG = "__platform__";

/**
 * Extract S3 key from a direct S3 URL if it matches our bucket.
 * e.g. https://bucket.s3.region.amazonaws.com/tenant-branding/xyz/file.jpg → tenant-branding/xyz/file.jpg
 */
const extractS3KeyFromUrl = (url) => {
  if (!url) return null;
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) return null;
  // Match: https://{bucket}.s3.{region}.amazonaws.com/{key}
  const pattern = new RegExp(
    `^https?://${bucket}\\.s3[.-][^/]+\\.amazonaws\\.com/(.+?)(?:\\?.*)?$`,
  );
  const match = url.match(pattern);
  return match ? match[1] : null;
};

/**
 * Resolve the S3 key for a tenant's logo. Handles:
 * 1. logoS3Key already set → use it
 * 2. logoUrl is a direct S3 URL for our bucket → extract key, backfill DB
 */
const resolveLogoS3Key = async (company, tenantId) => {
  if (company.logoS3Key) return company.logoS3Key;
  const extracted = extractS3KeyFromUrl(company.logoUrl);
  if (extracted && tenantId) {
    // Backfill logoS3Key in DB so future requests are fast
    Tenant.updateOne(
      { _id: tenantId },
      { $set: { "company.logoS3Key": extracted } },
    ).catch(() => {}); // fire-and-forget
  }
  return extracted;
};

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
    companyLogoUrl,
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
              logoUrl: companyLogoUrl || undefined,
              logoUpdatedAt: companyLogoUrl ? new Date() : undefined,
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
            email: String(adminEmail || "")
              .trim()
              .toLowerCase(),
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
    return next(
      ApiError.badRequest(error.message || "Failed to bootstrap tenant"),
    );
  }

  await dbSession.endSession();

  const authResult = await AuthService.login(adminEmail, adminPassword, {
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
    tenantSlug,
  });

  const isProduction = process.env.NODE_ENV === "production";

  res.cookie("accessToken", authResult.accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refreshToken", authResult.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
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
    const tenants = await Tenant.find({ slug: { $ne: PLATFORM_TENANT_SLUG } })
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

const getTenantCompanyLogo = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === "superadmin";

  if (!isSuperAdmin && String(req.user.tenantId) !== String(id)) {
    return next(ApiError.forbidden("You can only access your own tenant"));
  }

  const tenant = await Tenant.findById(id).select("company").lean();
  if (!tenant) {
    return next(ApiError.notFound("Tenant not found"));
  }

  const company = tenant.company || {};
  const s3Key = await resolveLogoS3Key(company, id);

  if (s3Key) {
    try {
      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: s3Key,
      });

      const objectResponse = await s3Client().send(command);
      if (!objectResponse?.Body) {
        return next(ApiError.notFound("Company logo not found"));
      }

      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader(
        "Content-Type",
        objectResponse.ContentType || "application/octet-stream",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");

      objectResponse.Body.pipe(res);
      return;
    } catch (error) {
      console.error("S3 GetObject error:", error);
      return next(ApiError.notFound("Company logo not found"));
    }
  }

  // Only redirect for truly external (non-S3) URLs
  if (company.logoUrl && !extractS3KeyFromUrl(company.logoUrl)) {
    return res.redirect(company.logoUrl);
  }

  return next(ApiError.notFound("Company logo not found"));
});

const getTenantCompanyLogoPublic = asyncHandler(async (req, res, next) => {
  const { id } = req.params;

  const tenant = await Tenant.findById(id).select("company").lean();
  if (!tenant) {
    return next(ApiError.notFound("Tenant not found"));
  }

  const company = tenant.company || {};
  const s3Key = await resolveLogoS3Key(company, id);

  if (s3Key) {
    try {
      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: s3Key,
      });

      const objectResponse = await s3Client().send(command);
      if (!objectResponse?.Body) {
        return next(ApiError.notFound("Company logo not found"));
      }

      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader(
        "Content-Type",
        objectResponse.ContentType || "application/octet-stream",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");

      objectResponse.Body.pipe(res);
      return;
    } catch (error) {
      console.error("S3 GetObject error:", error);
      return next(ApiError.notFound("Company logo not found"));
    }
  }

  // Only redirect for truly external (non-S3) URLs
  if (company.logoUrl && !extractS3KeyFromUrl(company.logoUrl)) {
    return res.redirect(company.logoUrl);
  }

  return next(ApiError.notFound("Company logo not found"));
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

  if (update.company) {
    const existingTenant = await Tenant.findById(id).select("company").lean();
    if (!existingTenant) {
      return next(ApiError.notFound("Tenant not found"));
    }

    update.company = {
      ...(existingTenant.company || {}),
      ...(update.company || {}),
    };

    if (Object.prototype.hasOwnProperty.call(update.company, "logoUrl")) {
      update.company.logoUpdatedAt = new Date();
      // Manual URL update should not keep stale S3 key.
      if (update.company.logoUrl) {
        update.company.logoS3Key = undefined;
      }
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

  // Notify connected clients about company info update via socket if available
  if (update.company && req.app?.get("socketio")) {
    req.app.get("socketio").to(`tenant_${id}`).emit("tenantCompanyUpdated", {
      tenantId: id,
      company: tenant.company,
    });
  }

  successResponse(res, { tenant }, "Tenant updated successfully");
});

const updateTenantCompanyLogo = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === "superadmin";

  if (!isSuperAdmin && String(req.user.tenantId) !== String(id)) {
    return next(ApiError.forbidden("You can only update your own tenant"));
  }

  if (!req.file) {
    return next(ApiError.badRequest("Logo file is required"));
  }

  const uploadResult = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    `tenant-branding/${id}`,
  );

  const tenant = await Tenant.findByIdAndUpdate(
    id,
    {
      $set: {
        "company.logoS3Key": uploadResult.key,
        "company.logoUpdatedAt": new Date(),
      },
      $unset: {
        "company.logoUrl": 1, // Clear external URL since we're using S3
      },
    },
    { new: true, runValidators: true },
  ).select("name slug company updatedAt");

  if (!tenant) {
    return next(ApiError.notFound("Tenant not found"));
  }

  // For S3-hosted logos, we don't return direct URLs
  // Frontend should use the API endpoint instead
  const logoUrl = null; // Always use API endpoint for S3 logos

  successResponse(
    res,
    { company: tenant.company, logoUrl },
    "Company logo updated successfully",
  );

  // Notify connected clients about logo update via socket if available
  if (req.app?.get("socketio")) {
    req.app.get("socketio").to(`tenant_${id}`).emit("tenantLogoUpdated", {
      tenantId: id,
      logoUpdatedAt: tenant.company.logoUpdatedAt,
    });
  }
});

export {
  bootstrapTenant,
  getTenants,
  getTenantById,
  getTenantCompanyLogo,
  getTenantCompanyLogoPublic,
  updateTenantById,
  updateTenantCompanyLogo,
};
