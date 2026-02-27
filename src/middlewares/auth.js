import { ApiError } from "../utils/apiResponse.js";
import { verifyAccessToken } from "../utils/jwt.js";
import User from "../models/User.js";
import Tenant from "../models/Tenant.js";
import logger from "../utils/logger.js";

// ═══════════════════════════════════════════════════════════
// ROLE HIERARCHY & PERMISSIONS (single source of truth)
// ═══════════════════════════════════════════════════════════

/**
 * Role hierarchy — lower number = higher privilege.
 * Used by hasMinimumRole() for level-based checks.
 */
const ROLE_HIERARCHY = {
  superadmin: 0,
  admin: 1,
  marketing: 2,
  user: 3,
};

/**
 * Granular permission map per role.
 * Used by requirePermission() for fine-grained access control.
 */
const ROLE_PERMISSIONS = {
  superadmin: [
    "users:create",
    "users:read",
    "users:update",
    "users:delete",
    "events:create",
    "events:read",
    "events:update",
    "events:delete",
    "clients:create",
    "clients:read",
    "clients:update",
    "clients:delete",
    "reports:read",
    "invites:create",
    "invites:manage",
    "settings:manage",
    "billing:manage",
    "admin:access",
    "tickets:create",
    "tickets:read",
    "tickets:update",
    "tickets:delete",
    "tickets:assign",
    "tickets:bulk",
  ],
  admin: [
    "users:create",
    "users:read",
    "users:update",
    "events:create",
    "events:read",
    "events:update",
    "clients:read",
    "clients:update",
    "reports:read",
    "invites:create",
    "settings:view",
    "tickets:create",
    "tickets:read",
    "tickets:update",
    "tickets:assign",
    "tickets:bulk",
  ],
  marketing: [
    "users:read",
    "events:read",
    "clients:create",
    "clients:read",
    "clients:update",
    "reports:read",
    "tickets:create",
    "tickets:read",
    "tickets:update",
  ],
  user: ["users:read", "events:read", "clients:read", "tickets:read"],
};

// ═══════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════

/**
 * Protect routes - Verify JWT token, validate tenant, attach user to request
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Get token from httpOnly cookie or Authorization header
    token = req.cookies?.accessToken;

    if (
      !token &&
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return next(ApiError.unauthorized("Access denied. No token provided."));
    }

    // Verify token
    const decoded = verifyAccessToken(token);

    // Get user from database
    if (!decoded?.tenantId) {
      return next(ApiError.unauthorized("Invalid token tenant context."));
    }

    const user = await User.findById(decoded.id).select(
      "-password -refreshToken",
    );

    if (!user) {
      return next(ApiError.unauthorized("User not found. Token invalid."));
    }

    if (!user.isActive) {
      return next(ApiError.unauthorized("User account is deactivated."));
    }

    if (!user.tenantId) {
      return next(ApiError.unauthorized("User tenant context missing."));
    }

    if (String(user.tenantId) !== String(decoded.tenantId)) {
      logger.warn(
        `Tenant mismatch for user ${user._id}: token=${decoded.tenantId} db=${user.tenantId}`,
      );
      return next(ApiError.forbidden("Tenant mismatch."));
    }

    const tenant = await Tenant.findById(user.tenantId)
      .select("isActive")
      .lean();
    if (!tenant || !tenant.isActive) {
      return next(ApiError.forbidden("Tenant is inactive."));
    }

    // Attach user to request
    req.tenantId = user.tenantId;
    req.user = user;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return next(ApiError.unauthorized("Invalid token."));
    }
    if (error.name === "TokenExpiredError") {
      return next(ApiError.unauthorized("Token expired. Please login again."));
    }
    logger.error(`Auth middleware error: ${error.message}`);
    return next(ApiError.unauthorized("Authentication failed."));
  }
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token;

    token = req.cookies?.accessToken;

    if (
      !token &&
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (token) {
      const decoded = verifyAccessToken(token);
      if (!decoded?.tenantId) {
        return next();
      }

      const user = await User.findById(decoded.id).select(
        "-password -refreshToken",
      );

      if (
        user &&
        user.isActive &&
        user.tenantId &&
        String(user.tenantId) === String(decoded.tenantId)
      ) {
        const tenant = await Tenant.findById(user.tenantId)
          .select("isActive")
          .lean();
        if (!tenant || !tenant.isActive) {
          return next();
        }
        req.tenantId = user.tenantId;
        req.user = user;
      }
    }

    next();
  } catch (error) {
    // Silently continue without user
    next();
  }
};

// ═══════════════════════════════════════════════════════════
// AUTHORIZATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════

/**
 * Role-based authorization.
 * Usage: authorize('admin', 'marketing')
 * @param  {...string} roles - Allowed roles
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized("Authentication required."));
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(
        `Unauthorized access attempt: User ${req.user._id} (${req.user.role}) tried to access ${req.originalUrl}`,
      );
      return next(
        ApiError.forbidden(
          `Role '${req.user.role}' is not authorized to access this resource.`,
        ),
      );
    }

    next();
  };
};

/**
 * Permission-based authorization.
 * Usage: requirePermission('users:create')
 * @param {string} permission - Required permission string
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized("Authentication required."));
    }

    const userRole = req.user.role;
    const userPermissions = ROLE_PERMISSIONS[userRole] || [];

    if (!userPermissions.includes(permission)) {
      logger.warn(
        `Permission denied: User ${req.user._id} (${userRole}) lacks permission '${permission}'`,
      );
      return next(ApiError.forbidden(`Permission denied: ${permission}`));
    }

    next();
  };
};

/**
 * Minimum role level authorization (uses hierarchy).
 * Usage: hasMinimumRole('admin') — allows admin and superadmin
 * @param {string} minimumRole - Minimum required role
 */
const hasMinimumRole = (minimumRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized("Authentication required."));
    }

    const userRole = req.user.role;
    const userLevel = ROLE_HIERARCHY[userRole];
    const minimumLevel = ROLE_HIERARCHY[minimumRole];

    if (userLevel === undefined || minimumLevel === undefined) {
      return next(ApiError.forbidden("Unknown role."));
    }

    if (userLevel > minimumLevel) {
      logger.warn(
        `Insufficient role: User ${req.user._id} (${userRole}) tried operation requiring ${minimumRole}`,
      );
      return next(
        ApiError.forbidden(`Requires ${minimumRole} role or higher.`),
      );
    }

    next();
  };
};

// ═══════════════════════════════════════════════════════════
// PRESETS
// ═══════════════════════════════════════════════════════════

/** Admin only middleware */
const adminOnly = authorize("admin", "superadmin");

/** Marketing or Admin middleware */
const marketingOrAdmin = authorize("admin", "superadmin", "marketing");

/** Superadmin only middleware */
const superAdminOnly = authorize("superadmin");

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

export {
  protect,
  authorize,
  adminOnly,
  marketingOrAdmin,
  superAdminOnly,
  optionalAuth,
  requirePermission,
  hasMinimumRole,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
};
