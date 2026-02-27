/**
 * Custom API Error class for consistent error handling
 */
class ApiError extends Error {
  constructor(statusCode, message, errors = [], isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = isOperational;
    this.errors = errors;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, errors = []) {
    return new ApiError(400, message, errors);
  }

  static unauthorized(message = "Unauthorized access") {
    return new ApiError(401, message);
  }

  static forbidden(message = "Access forbidden") {
    return new ApiError(403, message);
  }

  static notFound(message = "Resource not found") {
    return new ApiError(404, message);
  }

  static conflict(message = "Resource conflict") {
    return new ApiError(409, message);
  }

  static tooManyRequests(message = "Too many requests") {
    return new ApiError(429, message);
  }

  static internal(message = "Internal server error") {
    return new ApiError(500, message);
  }
}

// ── Semantic subclasses ──────────────────────────────────────
// These make `instanceof` checks cleaner and allow the error handler
// to set the correct status-code automatically even if the caller
// only throws `new ValidationError("…")` without a code.

/**
 * 400 — Payload failed validation (express-validator, Mongoose, etc.)
 */
class ValidationError extends ApiError {
  /**
   * @param {string}  message
   * @param {Array}   fieldErrors  - [{ field, message }]
   */
  constructor(message = "Validation failed", fieldErrors = []) {
    super(400, message, fieldErrors);
    this.name = "ValidationError";
  }
}

/**
 * 401 — Missing or invalid credentials / token
 */
class AuthenticationError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, message);
    this.name = "AuthenticationError";
  }
}

/**
 * 403 — Authenticated but lacks permission
 */
class AuthorizationError extends ApiError {
  constructor(message = "Insufficient permissions") {
    super(403, message);
    this.name = "AuthorizationError";
  }
}

/**
 * 404 — Entity does not exist (or is outside tenant scope)
 */
class NotFoundError extends ApiError {
  constructor(message = "Resource not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/**
 * Wrap async route handlers to catch errors
 * @param {Function} fn - Async function to wrap
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Success response helper
 * @param {Object} res - Express response object
 * @param {Object} data - Response data
 * @param {string} message - Success message
 * @param {number} statusCode - HTTP status code
 */
const successResponse = (
  res,
  data = null,
  message = "Success",
  statusCode = 200,
) => {
  const response = {
    success: true,
    message,
  };

  if (data !== null) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

/**
 * Paginated response helper
 * @param {Object} res - Express response object
 * @param {Array} data - Response data array
 * @param {Object} pagination - Pagination info
 * @param {string} message - Success message
 */
const paginatedResponse = (res, data, pagination, message = "Success") => {
  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      totalPages: pagination.totalPages,
      totalDocs: pagination.totalDocs,
      hasNextPage: pagination.page < pagination.totalPages,
      hasPrevPage: pagination.page > 1,
    },
  });
};

export {
  ApiError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  asyncHandler,
  successResponse,
  paginatedResponse,
};
