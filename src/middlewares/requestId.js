import crypto from "crypto";

/**
 * Attach a unique requestId to every incoming request.
 * Downstream code can use `req.requestId` or read the X-Request-Id header.
 *
 * Also exposes a `req.logContext()` helper that returns
 * { requestId, tenantId, userId } — handy for structured logging.
 */
const requestIdMiddleware = (req, _res, next) => {
  const id = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = id;
  _res.setHeader("X-Request-Id", id);

  /**
   * Convenience: builds a metadata object for logger.info / logger.error.
   * Usage:  logger.info("Did something", req.logContext())
   */
  req.logContext = () => ({
    requestId: req.requestId,
    tenantId: req.user?.tenantId?.toString?.() ?? undefined,
    userId: req.user?.id?.toString?.() ?? undefined,
  });

  next();
};

export default requestIdMiddleware;
