import rateLimit from "express-rate-limit";

const isDevelopment = process.env.NODE_ENV === "development";
const isRateLimitDisabled = process.env.DISABLE_RATE_LIMIT === "true";

const createLimiter = (options) => {
  if (isDevelopment || isRateLimitDisabled) {
    return (req, res, next) => next();
  }

  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
};

/**
 * General API rate limiter
 */
const apiLimiter = createLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100, // 100 requests per window
  message: {
    success: false,
    status: "fail",
    message: "Too many requests, please try again later.",
  },
  skip: (req) => {
    const isLiveDashboardGet =
      req.method === "GET" &&
      (req.originalUrl.startsWith("/api/dashboard/") ||
        req.originalUrl.startsWith("/api/sessions/marketing/"));

    // Skip global limiter for health checks and auth routes
    return (
      req.path === "/health" ||
      req.originalUrl === "/api/health" ||
      req.originalUrl.startsWith("/api/auth/") ||
      isLiveDashboardGet
    );
  },
});

/**
 * Strict rate limiter for authentication routes
 */
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 login attempts per 15 minutes
  message: {
    success: false,
    status: "fail",
    message: "Too many login attempts, please try again after 15 minutes.",
  },
  // Only failed attempts should count for auth endpoints
  skipSuccessfulRequests: true,
});

/**
 * Strict rate limiter for password reset
 */
const passwordResetLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  message: {
    success: false,
    status: "fail",
    message: "Too many password reset requests, please try again later.",
  },
});

/**
 * Rate limiter for file uploads
 */
const uploadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  message: {
    success: false,
    status: "fail",
    message: "Upload limit reached, please try again later.",
  },
});

/**
 * Rate limiter for data exports
 */
const exportLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 exports per hour
  message: {
    success: false,
    status: "fail",
    message: "Export limit reached, please try again later.",
  },
});

export {
  apiLimiter,
  authLimiter,
  passwordResetLimiter,
  uploadLimiter,
  exportLimiter,
};
