import logger from "../utils/logger.js";

/**
 * Request duration middleware — tracks how long each request takes.
 * Logs slow requests (>500ms) as warnings.
 * Always attaches X-Response-Time header.
 */
const requestDuration = (req, res, next) => {
  const start = process.hrtime.bigint();

  // Intercept response end to measure duration
  const originalEnd = res.end.bind(res);
  res.end = function (...args) {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = (durationNs / 1_000_000).toFixed(2);

    // Set header only while headers are still mutable.
    if (!res.headersSent) {
      res.setHeader("X-Response-Time", `${durationMs}ms`);
    }

    // Log slow requests (>500ms)
    if (durationMs > 500) {
      logger.warn("Slow request detected", {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: parseFloat(durationMs),
        requestId: req.requestId,
        tenantId:
          req.tenantId?.toString?.() || req.user?.tenantId?.toString?.(),
        userId: req.user?._id?.toString?.(),
      });
    }

    return originalEnd(...args);
  };

  next();
};

export { requestDuration };
