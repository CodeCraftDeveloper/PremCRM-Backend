import {
  ApiError,
  ValidationError,
  AuthenticationError,
  NotFoundError,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";
import { MAX_FILE_SIZE } from "./upload.js";

/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let error = err;

  // Already an ApiError (or subclass) — use as-is
  if (error instanceof ApiError) {
    // pass through
  }
  // Mongoose bad ObjectId
  else if (err.name === "CastError") {
    error = new NotFoundError("Resource not found");
  }
  // Mongoose duplicate key error
  else if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    error = ApiError.conflict(
      `Duplicate value entered for ${field}. Please use another value.`,
    );
  }
  // Mongoose validation error
  else if (err.name === "ValidationError" && err.errors) {
    const fieldErrors = Object.values(err.errors).map((el) => ({
      field: el.path,
      message: el.message,
    }));
    error = new ValidationError("Validation failed", fieldErrors);
  }
  // JWT errors
  else if (err.name === "JsonWebTokenError") {
    error = new AuthenticationError("Invalid token");
  } else if (err.name === "TokenExpiredError") {
    error = new AuthenticationError("Token expired");
  }
  // Multer errors
  else if (err.code === "LIMIT_FILE_SIZE") {
    error = new ValidationError(
      `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`,
    );
  } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
    error = new ValidationError("Unexpected file field.");
  }

  // Default error response
  const statusCode = error.statusCode || 500;
  const status = error.status || "error";
  const logMeta = {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    requestId: req.requestId,
    tenantId: req.user?.tenantId,
    userId: req.user?.id,
    statusCode,
  };

  // Avoid noisy stack traces for expected client/auth failures.
  if (statusCode >= 500) {
    logger.error(`${error.message}`, {
      ...logMeta,
      stack: error.stack || err.stack,
    });
  } else {
    logger.warn(`${error.message}`, logMeta);
  }

  res.status(statusCode).json({
    success: false,
    status,
    message: error.message || "Internal server error",
    errors: error.errors || [],
    ...(req.requestId && { requestId: req.requestId }),
    ...(process.env.NODE_ENV === "development" &&
      statusCode >= 500 && { stack: error.stack }),
  });
};

/**
 * Not found handler for undefined routes
 */
const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route ${req.originalUrl} not found`));
};

export { errorHandler, notFound };
