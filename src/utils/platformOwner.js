import Tenant from "../models/Tenant.js";
import { ApiError } from "./apiResponse.js";

const PLATFORM_TENANT_SLUG = "__platform__";
const PLATFORM_OWNER_EMAIL = "pappumahato000@gmail.com";
const PLATFORM_OWNER_PASSWORD = "Charan@CRMSUPERADMIN007";

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const isPlatformOwnerEmail = (email) =>
  normalizeEmail(email) === PLATFORM_OWNER_EMAIL;

const hasPlatformTenant = async (user) => {
  const tenantSlug = user?.tenantId?.slug || user?.tenant?.slug;
  if (tenantSlug) return tenantSlug === PLATFORM_TENANT_SLUG;

  if (!user?.tenantId) return false;
  const tenant = await Tenant.findById(user.tenantId).select("slug").lean();
  return tenant?.slug === PLATFORM_TENANT_SLUG;
};

const isProtectedPlatformOwner = async (user) => {
  if (!user || user.role !== "superadmin") return false;
  return isPlatformOwnerEmail(user.email) || (await hasPlatformTenant(user));
};

const assertMutablePlatformUser = async (
  user,
  message = "Platform Owner credentials are fixed and cannot be changed",
) => {
  if (await isProtectedPlatformOwner(user)) {
    throw ApiError.forbidden(message);
  }
};

export {
  PLATFORM_TENANT_SLUG,
  PLATFORM_OWNER_EMAIL,
  PLATFORM_OWNER_PASSWORD,
  normalizeEmail,
  isPlatformOwnerEmail,
  isProtectedPlatformOwner,
  assertMutablePlatformUser,
};
