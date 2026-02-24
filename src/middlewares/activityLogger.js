import ActivityLog from "../models/ActivityLog.js";
import logger from "../utils/logger.js";

/**
 * Middleware to log user activity
 * @param {string} action - Action type
 * @param {string} resourceType - Resource type
 * @param {Function} descriptionFn - Function to generate description
 */
const logActivity = (action, resourceType, descriptionFn) => {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json method to log after successful response
    res.json = function (data) {
      // Only log on successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Log asynchronously to not block response
        setImmediate(async () => {
          try {
            const description =
              typeof descriptionFn === "function"
                ? descriptionFn(req, data)
                : descriptionFn;

            await ActivityLog.log({
              user: req.user?._id,
              action,
              resourceType,
              resourceId: data?.data?._id || req.params.id || null,
              description,
              metadata: {
                body: sanitizeLogData(req.body),
                params: req.params,
                query: req.query,
              },
              ipAddress: req.ip || req.connection.remoteAddress,
              userAgent: req.get("User-Agent"),
            });
          } catch (error) {
            logger.error(`Activity logging failed: ${error.message}`);
          }
        });
      }

      return originalJson(data);
    };

    next();
  };
};

/**
 * Sanitize sensitive data before logging
 * @param {Object} data - Data to sanitize
 */
const sanitizeLogData = (data) => {
  if (!data) return {};

  const sanitized = { ...data };
  const sensitiveFields = [
    "password",
    "confirmPassword",
    "currentPassword",
    "newPassword",
    "token",
    "refreshToken",
  ];

  sensitiveFields.forEach((field) => {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  });

  return sanitized;
};

/**
 * Pre-built activity loggers for common actions
 */
const activityLoggers = {
  login: logActivity(
    "login",
    "user",
    (req) => `User logged in: ${req.body.email}`,
  ),
  logout: logActivity(
    "logout",
    "user",
    (req) => `User logged out: ${req.user?.email}`,
  ),

  createUser: logActivity(
    "user_create",
    "user",
    (req, data) => `Created user: ${data?.data?.email}`,
  ),
  updateUser: logActivity(
    "user_update",
    "user",
    (req) => `Updated user: ${req.params.id}`,
  ),
  deleteUser: logActivity(
    "user_delete",
    "user",
    (req) => `Deleted user: ${req.params.id}`,
  ),

  createEvent: logActivity(
    "event_create",
    "event",
    (req, data) => `Created event: ${data?.data?.name}`,
  ),
  updateEvent: logActivity(
    "event_update",
    "event",
    (req) => `Updated event: ${req.params.id}`,
  ),
  deleteEvent: logActivity(
    "event_delete",
    "event",
    (req) => `Deleted event: ${req.params.id}`,
  ),

  createClient: logActivity(
    "client_create",
    "client",
    (req, data) => `Created client: ${data?.data?.name}`,
  ),
  updateClient: logActivity(
    "client_update",
    "client",
    (req) => `Updated client: ${req.params.id}`,
  ),
  deleteClient: logActivity(
    "client_delete",
    "client",
    (req) => `Deleted client: ${req.params.id}`,
  ),

  createRemark: logActivity(
    "remark_create",
    "remark",
    (req) => `Added remark to client: ${req.params.clientId}`,
  ),

  uploadFile: logActivity(
    "file_upload",
    "file",
    (req) => `Uploaded file for client: ${req.params.id}`,
  ),

  exportData: logActivity(
    "data_export",
    "system",
    (req) => `Exported ${req.query.type || "clients"} data`,
  ),
};

export { logActivity, activityLoggers };
