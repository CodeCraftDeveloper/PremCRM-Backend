import mongoose from "mongoose";

/**
 * requestValidators.js — Shared Express middleware for route-level input validation.
 *
 * Validates common request parameters (Mongo ObjectIds, required body fields,
 * enum values, pagination) *before* they reach controllers/services.
 *
 * Usage:
 *   import { validateMongoId, requireBodyFields, validateEnum, validatePagination } from "../middlewares/requestValidators.js";
 *   router.get("/:id", validateMongoId("id"), getContact);
 *   router.post("/", requireBodyFields("name", "email"), createContact);
 */

/**
 * Validate that a route param is a valid MongoDB ObjectId.
 * @param {string} paramName - the req.params key (default: "id")
 */
export function validateMongoId(paramName = "id") {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (value && !mongoose.Types.ObjectId.isValid(value)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${paramName}: "${value}" is not a valid ObjectId`,
      });
    }
    next();
  };
}

/**
 * Validate that required fields exist in req.body.
 * @param  {...string} fields - field names that must be present and non-empty
 */
export function requireBodyFields(...fields) {
  return (req, res, next) => {
    const missing = fields.filter((f) => {
      const val = req.body[f];
      return val === undefined || val === null || val === "";
    });
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
      });
    }
    next();
  };
}

/**
 * Validate that a body field contains one of the allowed enum values.
 * @param {string} field - the req.body key to validate
 * @param {string[]} allowedValues - permitted values
 */
export function validateEnum(field, allowedValues) {
  return (req, res, next) => {
    const value = req.body[field];
    if (value !== undefined && !allowedValues.includes(value)) {
      return res.status(400).json({
        success: false,
        message: `Invalid value for "${field}": "${value}". Allowed: ${allowedValues.join(", ")}`,
      });
    }
    next();
  };
}

/**
 * Sanitize and clamp pagination query params (page, limit).
 * Ensures page >= 1 and 1 <= limit <= 100.
 * Attaches sanitized values to req.query for downstream use.
 */
export function validatePagination() {
  return (req, res, next) => {
    if (req.query.page !== undefined) {
      const p = parseInt(req.query.page, 10);
      if (isNaN(p) || p < 1) {
        return res.status(400).json({
          success: false,
          message: `Invalid page: "${req.query.page}". Must be a positive integer.`,
        });
      }
      req.query.page = String(p);
    }
    if (req.query.limit !== undefined) {
      const l = parseInt(req.query.limit, 10);
      if (isNaN(l) || l < 1) {
        return res.status(400).json({
          success: false,
          message: `Invalid limit: "${req.query.limit}". Must be a positive integer.`,
        });
      }
      // Clamp to MAX_LIMIT (100) at the route level
      req.query.limit = String(Math.min(l, 100));
    }
    next();
  };
}

/**
 * Reject any request body keys not in the provided allowlist.
 * Returns 400 with the list of unexpected keys.
 *
 * @param {string[]} allowedFields - keys that may legally appear in req.body
 */
export function rejectUnknownFields(allowedFields) {
  const allowed = new Set(allowedFields);
  return (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return next();
    }
    const unknown = Object.keys(req.body).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unknown fields in request body: ${unknown.join(", ")}`,
      });
    }
    next();
  };
}
