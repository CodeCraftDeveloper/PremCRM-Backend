import { ApiError } from "../utils/apiResponse.js";
import { verifyAccessToken } from "../utils/jwt.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";

/**
 * Protect routes - Verify JWT token and attach user to request
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Get token from header
    if (
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
    const user = await User.findById(decoded.id).select(
      "-password -refreshToken",
    );

    if (!user) {
      return next(ApiError.unauthorized("User not found. Token invalid."));
    }

    if (!user.isActive) {
      return next(ApiError.unauthorized("User account is deactivated."));
    }

    // Attach user to request
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
const adminOnly = authorize("admin");

/**
 * Marketing or Admin middleware
 */
const marketingOrAdmin = authorize("admin", "marketing");

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (token) {
      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id).select(
        "-password -refreshToken",
      );

      if (user && user.isActive) {
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
