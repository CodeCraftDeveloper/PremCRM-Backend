import { ApiError } from "../utils/apiResponse.js";
import logger from "../utils/logger.js";
import { MAX_FILE_SIZE } from "./upload.js";

/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.stack = err.stack;

  // Log error
  logger.error(`${err.message}`, {
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user: req.user?.id,
  });

  // Mongoose bad ObjectId
  if (err.name === "CastError") {
    const message = "Resource not found";
    error = ApiError.notFound(message);
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `Duplicate value entered for ${field}. Please use another value.`;
    error = ApiError.conflict(message);
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((el) => ({
      field: el.path,
      message: el.message,
    }));
    error = ApiError.badRequest("Validation failed", errors);
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    error = ApiError.unauthorized("Invalid token");
  }

  if (err.name === "TokenExpiredError") {
    error = ApiError.unauthorized("Token expired");
  }

  // Multer errors
  if (err.code === "LIMIT_FILE_SIZE") {
    error = ApiError.badRequest(
      `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`,
    );
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    error = ApiError.badRequest("Unexpected file field.");
  }

  // Default error response
  const statusCode = error.statusCode || 500;
  const status = error.status || "error";

  res.status(statusCode).json({
    success: false,
    status,
    message: error.message || "Internal server error",
    errors: error.errors || [],
    ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
  });
};

/**
 * Not found handler for undefined routes
 */
const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route ${req.originalUrl} not found`));
};

export { errorHandler, notFound };
