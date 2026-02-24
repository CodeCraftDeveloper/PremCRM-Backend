/**
 * Common validation schemas and helper functions
 */
import { body, param, query, validationResult } from "express-validator";
import { ApiError } from "./apiResponse.js";

/**
 * Validate request and throw error if validation fails
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));
    return next(ApiError.badRequest("Validation failed", formattedErrors));
  }
  next();
};

/**
 * Common validation rules
 */
const commonValidations = {
  mongoId: (field, location = "params") => {
    const validator = location === "params" ? param(field) : body(field);
    return validator
      .notEmpty()
      .withMessage(`${field} is required`)
      .isMongoId()
      .withMessage(`Invalid ${field} format`);
  },

  email: (field = "email") =>
    body(field)
      .trim()
      .notEmpty()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail(),

  password: (field = "password") =>
    body(field)
      .notEmpty()
      .withMessage("Password is required")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters")
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage("Password must contain uppercase, lowercase, and number"),

  phone: (field = "phone") =>
    body(field)
      .optional()
      .trim()
      .isMobilePhone("any")
      .withMessage("Invalid phone number"),

  pagination: () => [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer")
      .toInt(),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100")
      .toInt(),
    query("sortBy").optional().isString().trim(),
    query("sortOrder")
      .optional()
      .isIn(["asc", "desc"])
      .withMessage("Sort order must be asc or desc"),
  ],

  stringField: (field, options = {}) => {
    let validator = body(field);

    if (options.required) {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    } else {
      validator = validator.optional();
    }

    validator = validator.trim();

    if (options.minLength) {
      validator = validator
        .isLength({ min: options.minLength })
        .withMessage(
          `${field} must be at least ${options.minLength} characters`,
        );
    }

    if (options.maxLength) {
      validator = validator
        .isLength({ max: options.maxLength })
        .withMessage(
          `${field} must be at most ${options.maxLength} characters`,
        );
    }

    return validator;
  },

  enumField: (field, values, options = {}) => {
    let validator = body(field);

    if (options.required) {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    } else {
      validator = validator.optional();
    }

    return validator
      .isIn(values)
      .withMessage(`${field} must be one of: ${values.join(", ")}`);
  },

  dateField: (field, options = {}) => {
    let validator = body(field);

    if (options.required) {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    } else {
      validator = validator.optional();
    }

    return validator.isISO8601().withMessage(`${field} must be a valid date`);
  },
};

export { validate, commonValidations };
