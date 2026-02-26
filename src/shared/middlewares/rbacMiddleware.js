import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import logger from "../../utils/logger.js";

/**
 * RBAC Middleware
 * Centralized role-based access control
 * All authorization happens at middleware level, NOT in controllers
 */

// Role hierarchy: permissions cascade downward
const ROLE_HIERARCHY = {
  superadmin: 0,
  admin: 1,
  marketing: 2,
  user: 3,
};

// Permission definitions by role
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
  ],
  marketing: [
    "users:read", // Self only
    "events:read",
    "clients:create",
    "clients:read",
    "clients:update",
    "reports:read",
  ],
  user: ["users:read", "events:read", "clients:read"],
};

/**
 * Authenticate token from httpOnly cookie or header
 */
export const authenticateToken = async (req, res, next) => {
  try {
    // Get token from httpOnly cookie or Authorization header
    let token = req.cookies?.accessToken;

    if (!token) {
      const authHeader = req.headers.authorization;
      token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token provided, authentication required",
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key",
    );

    // Fetch user from database
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "User account is deactivated",
      });
    }

    // Attach user to request
    req.user = user;
    req.decoded = decoded;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    logger.error(`Token verification error: ${error.message}`);
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
};

/**
 * Enforce tenant isolation
 * Prevents users from accessing other tenants' data
 */
export const tenantContextMiddleware = async (req, res, next) => {
  try {
    // Extract tenantId from JWT
    const tenantIdFromJWT = req.decoded?.tenantId;

    if (!tenantIdFromJWT) {
      return res.status(403).json({
        success: false,
        message: "Tenant not specified in token",
      });
    }

    // Optional: Check X-Tenant-ID header to prevent override attempts
    const headerTenantId = req.headers["x-tenant-id"];
    if (headerTenantId && headerTenantId !== tenantIdFromJWT.toString()) {
      logger.warn(
        `Tenant ID mismatch for user ${req.user._id}: JWT=${tenantIdFromJWT}, Header=${headerTenantId}`,
      );
      return res.status(403).json({
        success: false,
        message: "Tenant mismatch",
      });
    }

    // Attach tenant context to request
    req.tenant = {
      id: tenantIdFromJWT,
      _id: tenantIdFromJWT,
    };

    next();
  } catch (error) {
    logger.error(`Tenant context error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Tenant context error",
    });
  }
};

/**
 * Role-based authorization
 * Usage: authorize('admin', 'marketing')
 */
export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role;

    if (!userRole) {
      return res.status(403).json({
        success: false,
        message: "User role not found",
      });
    }

    const hasRole = allowedRoles.includes(userRole);

    if (!hasRole) {
      logger.warn(
        `Unauthorized access attempt: User ${req.user._id} (${userRole}) tried to access ${req.originalUrl}`,
      );
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role(s): ${allowedRoles.join(", ")}`,
      });
    }

    next();
  };
};

/**
 * Permission-based authorization
 * Usage: requirePermission('users:create')
 */
export const requirePermission = (permission) => {
  return (req, res, next) => {
    const userRole = req.user?.role;
    const userPermissions = ROLE_PERMISSIONS[userRole] || [];

    if (!userPermissions.includes(permission)) {
      logger.warn(
        `Permission denied: User ${req.user._id} (${userRole}) lacks permission '${permission}'`,
      );
      return res.status(403).json({
        success: false,
        message: `Permission denied: ${permission}`,
      });
    }

    next();
  };
};

/**
 * Verify user has higher or equal privilege
 * For operations that require specific minimum role
 */
export const hasMinimumRole = (minimumRole) => {
  return (req, res, next) => {
    const userRole = req.user?.role;
    const userLevel = ROLE_HIERARCHY[userRole];
    const minimumLevel = ROLE_HIERARCHY[minimumRole];

    if (userLevel > minimumLevel) {
      // Higher number = lower privileges
      logger.warn(
        `Insufficient role: User ${req.user._id} (${userRole}) tried operation requiring ${minimumRole}`,
      );
      return res.status(403).json({
        success: false,
        message: `Requires ${minimumRole} role or higher`,
      });
    }

    next();
  };
};

/**
 * Verify resource ownership or admin
 * Usage: verifyResourceOwner('User')
 */
export const verifyResourceOwner = (resourceModel) => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params.id;
      const resource = await resourceModel.findById(resourceId);

      if (!resource) {
        return res.status(404).json({
          success: false,
          message: "Resource not found",
        });
      }

      // Check if resource belongs to same tenant
      if (resource.tenantId?.toString() !== req.tenant.id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      // Allow if user is owner or admin
      const isOwner = resource.createdBy?.equals(req.user._id);
      const isAdmin = ["admin", "superadmin"].includes(req.user.role);

      if (!isOwner && !isAdmin) {
        logger.warn(
          `Resource access denied: User ${req.user._id} tried to access resource ${resourceId}`,
        );
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      req.resource = resource;
      next();
    } catch (error) {
      logger.error(`Resource ownership check error: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: "Resource check error",
      });
    }
  };
};

/**
 * Admin-only access
 */
export const adminOnly = authorize("admin", "superadmin");

/**
 * Superadmin-only access
 */
export const superAdminOnly = authorize("superadmin");

/**
 * Audit log middleware
 * Log sensitive operations
 */
export const auditLog = (action, resourceType) => {
  return async (req, res, next) => {
    // Capture original send function
    const originalSend = res.send;

    res.send = function (data) {
      // Log after response is prepared
      if (res.statusCode < 400) {
        logger.info(
          `AUDIT: ${action} - User: ${req.user._id}, Resource: ${resourceType}, Status: ${res.statusCode}`,
        );
      } else {
        logger.warn(
          `AUDIT FAILED: ${action} - User: ${req.user._id}, Status: ${res.statusCode}`,
        );
      }

      return originalSend.call(this, data);
    };

    next();
  };
};

export default {
  authenticateToken,
  tenantContextMiddleware,
  authorize,
  requirePermission,
  hasMinimumRole,
  verifyResourceOwner,
  adminOnly,
  superAdminOnly,
  auditLog,
};
