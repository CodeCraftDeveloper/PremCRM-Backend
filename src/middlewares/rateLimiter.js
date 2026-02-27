import rateLimit from "express-rate-limit";

const isTestEnv = process.env.NODE_ENV === "test";

const createLimiter = (options) => {
  if (isTestEnv) {
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
 *
 * Authenticated users are keyed by userId (not shared IP) so
 * colleagues behind the same NAT don't exhaust each other's budget.
 * The bearer/cookie blanket-skip has been removed — every caller
 * is now subject to a generous but real cap.
 *
 * Routes that already have their own dedicated limiters (auth, public,
 * public CRM forms) are still skipped here to avoid double-counting.
 */
const apiLimiter = createLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX) || 300, // 300 requests per window
  message: {
    success: false,
    status: "fail",
    message: "Too many requests, please try again later.",
  },
  // Key by authenticated userId when available; fall back to IP.
  keyGenerator: (req) => {
    if (req.user && req.user._id) return `user_${req.user._id}`;
    return req.ip;
  },
  // Suppress false-positive IPv6 validation — our generator only uses
  // req.ip as fallback for anonymous requests; authenticated users get
  // a per-user key that is not IP-derived.
  validate: { keyGeneratorIpFallback: false },
  skip: (req) => {
    const isV1Route = req.originalUrl.startsWith("/api/v1/");
    const authPrefix = isV1Route ? "/api/v1/auth/" : "/api/auth/";
    const publicPrefix = isV1Route ? "/api/v1/public/" : "/api/public/";
    const publicCrmFormsPrefix = isV1Route
      ? "/api/v1/crm/forms/public/"
      : "/api/crm/forms/public/";
    const dashboardPrefix = isV1Route
      ? "/api/v1/dashboard/"
      : "/api/dashboard/";
    const sessionsPrefix = isV1Route
      ? "/api/v1/sessions/marketing/"
      : "/api/sessions/marketing/";
    const healthPath = isV1Route ? "/api/v1/health" : "/api/health";

    const isLiveDashboardGet =
      req.method === "GET" &&
      (req.originalUrl.startsWith(dashboardPrefix) ||
        req.originalUrl.startsWith(sessionsPrefix));

    // Skip global limiter only for routes with their own dedicated limiters
    return (
      req.path === "/health" ||
      req.originalUrl === healthPath ||
      req.originalUrl.startsWith(authPrefix) ||
      req.originalUrl.startsWith(publicPrefix) ||
      req.originalUrl.startsWith(publicCrmFormsPrefix) ||
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

/**
 * Rate limiter for public lead intake (website forms)
 * Per-IP to prevent form-spam.
 */
const publicLeadLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 submissions per 15 min per IP
  message: {
    success: false,
    status: "fail",
    message: "Too many submissions. Please try again later.",
  },
});

/**
 * Rate limiter for CRM public form fetch/submit (per-IP).
 * Strict: protects tenant form definitions from scraping + spam submissions.
 *
 * Phase 2 Hardening — burst protection:
 *   - 20 requests per 5 minutes per IP (generous for real users)
 *   - Short window catches sudden bursts from bots
 */
const publicFormFetchLimiter = createLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 requests per 5 min per IP
  message: {
    success: false,
    status: "fail",
    message: "Too many form requests. Please try again in a few minutes.",
  },
});

/**
 * Rate limiter for CRM public form submission (per-IP).
 * Even stricter than fetch — a real user submits only once.
 */
const publicFormSubmitLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 submissions per 15 min per IP
  message: {
    success: false,
    status: "fail",
    message: "Too many form submissions. Please try again later.",
  },
  skipSuccessfulRequests: false,
});

/**
 * Rate limiter for tenant bootstrap (anti-automation guard).
 * Very strict: 3 tenant creations per IP per hour.
 */
const bootstrapLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 bootstrap attempts per hour per IP
  message: {
    success: false,
    status: "fail",
    message: "Too many tenant creation attempts. Please try again later.",
  },
  skipSuccessfulRequests: false,
});

export {
  apiLimiter,
  authLimiter,
  passwordResetLimiter,
  uploadLimiter,
  exportLimiter,
  publicLeadLimiter,
  publicFormFetchLimiter,
  publicFormSubmitLimiter,
  bootstrapLimiter,
};
