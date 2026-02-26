import { ApiError } from "../utils/apiResponse.js";
import { verifyAccessToken } from "../utils/jwt.js";
import User from "../models/User.js";
import Tenant from "../models/Tenant.js";
import logger from "../utils/logger.js";

/**
 * Protect routes - Verify JWT token and attach user to request
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

    const tenant = await Tenant.findById(user.tenantId).select("isActive").lean();
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
 * Authorize specific roles
 * @param  {...string} roles - Allowed roles
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized("Authentication required."));
    }

    if (!roles.includes(req.user.role)) {
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
 * Admin only middleware
 */
const adminOnly = authorize("admin", "superadmin");

/**
 * Marketing or Admin middleware
 */
const marketingOrAdmin = authorize("admin", "superadmin", "marketing");

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

export { protect, authorize, adminOnly, marketingOrAdmin, optionalAuth };
