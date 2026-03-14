import express from "express";
import { body } from "express-validator";
import {
  getEvents,
  getActiveEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  getEventStats,
} from "../controllers/eventController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/events/active
 * @desc    Get active events (for dropdowns)
 * @access  Private
 */
router.get("/active", getActiveEvents);

/**
 * @route   GET /api/events
 * @desc    Get all events
 * @access  Private
 */
router.get("/", [...commonValidations.pagination(), validate], getEvents);

/**
 * @route   GET /api/events/:id
 * @desc    Get single event
 * @access  Private
 */
router.get("/:id", [commonValidations.mongoId("id"), validate], getEvent);

/**
 * @route   GET /api/events/:id/stats
 * @desc    Get event statistics
 * @access  Private
 */
router.get(
  "/:id/stats",
  [commonValidations.mongoId("id"), validate],
  getEventStats,
);

/**
 * @route   POST /api/events
 * @desc    Create event
 * @access  Private/Admin
 */
router.post(
  "/",
  adminOnly,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Event name is required")
      .isLength({ max: 200 })
      .withMessage("Event name cannot exceed 200 characters"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Description cannot exceed 2000 characters"),
    body("location")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Location cannot exceed 500 characters"),
    body("startDate")
      .notEmpty()
      .withMessage("Start date is required")
      .isISO8601()
      .withMessage("Invalid start date format"),
    body("endDate")
      .notEmpty()
      .withMessage("End date is required")
      .isISO8601()
      .withMessage("Invalid end date format"),
    body("targetLeads")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Target leads must be a positive integer"),
    body("budget")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Budget must be a positive number"),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    body("image")
      .optional()
      .isString()
      .withMessage("Image must be a string URL"),
    body("landing")
      .optional()
      .isObject()
      .withMessage("landing must be an object"),
    body("landing.heroImageUrl")
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage("landing.heroImageUrl cannot exceed 500 characters"),
    body("landing.heroTagline")
      .optional()
      .isString()
      .isLength({ max: 160 })
      .withMessage("landing.heroTagline cannot exceed 160 characters"),
    body("landing.accentColor")
      .optional()
      .isString()
      .matches(/^#?[0-9A-Fa-f]{3,8}$/)
      .withMessage("landing.accentColor must be a valid hex color"),
    body("registrationFields")
      .optional()
      .isArray({ max: 25 })
      .withMessage("registrationFields must be an array (max 25)"),
    body("registrationFields.*.key")
      .optional()
      .isString()
      .matches(/^[a-zA-Z0-9_-]{2,60}$/)
      .withMessage(
        "registrationFields key must be 2-60 chars (letters, numbers, _ or -)",
      ),
    body("registrationFields.*.label")
      .optional()
      .isString()
      .isLength({ min: 1, max: 120 })
      .withMessage("registrationFields label must be 1-120 characters"),
    body("registrationFields.*.type")
      .optional()
      .isIn(["text", "textarea", "select", "number", "date", "url"])
      .withMessage("registrationFields type is invalid"),
    body("registrationFields.*.required")
      .optional()
      .isBoolean()
      .withMessage("registrationFields.required must be boolean"),
    body("registrationFields.*.options")
      .optional()
      .isArray({ max: 50 })
      .withMessage("registrationFields options must be an array"),
    body("assignedUsers")
      .optional()
      .isArray()
      .withMessage("Assigned users must be an array"),
    validate,
  ],
  createEvent,
);

/**
 * @route   PUT /api/events/:id
 * @desc    Update event
 * @access  Private/Admin
 */
router.put(
  "/:id",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    body("name")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Event name cannot exceed 200 characters"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Description cannot exceed 2000 characters"),
    body("status")
      .optional()
      .isIn(["upcoming", "active", "completed", "cancelled"])
      .withMessage("Invalid status"),
    body("startDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid start date format"),
    body("endDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid end date format"),
    body("targetLeads")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Target leads must be a positive integer"),
    body("budget")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Budget must be a positive number"),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    body("image")
      .optional()
      .isString()
      .withMessage("Image must be a string URL"),
    body("landing")
      .optional()
      .isObject()
      .withMessage("landing must be an object"),
    body("landing.heroImageUrl")
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage("landing.heroImageUrl cannot exceed 500 characters"),
    body("landing.heroTagline")
      .optional()
      .isString()
      .isLength({ max: 160 })
      .withMessage("landing.heroTagline cannot exceed 160 characters"),
    body("landing.accentColor")
      .optional()
      .isString()
      .matches(/^#?[0-9A-Fa-f]{3,8}$/)
      .withMessage("landing.accentColor must be a valid hex color"),
    body("registrationFields")
      .optional()
      .isArray({ max: 25 })
      .withMessage("registrationFields must be an array (max 25)"),
    body("registrationFields.*.key")
      .optional()
      .isString()
      .matches(/^[a-zA-Z0-9_-]{2,60}$/)
      .withMessage(
        "registrationFields key must be 2-60 chars (letters, numbers, _ or -)",
      ),
    body("registrationFields.*.label")
      .optional()
      .isString()
      .isLength({ min: 1, max: 120 })
      .withMessage("registrationFields label must be 1-120 characters"),
    body("registrationFields.*.type")
      .optional()
      .isIn(["text", "textarea", "select", "number", "date", "url"])
      .withMessage("registrationFields type is invalid"),
    body("registrationFields.*.required")
      .optional()
      .isBoolean()
      .withMessage("registrationFields.required must be boolean"),
    body("registrationFields.*.options")
      .optional()
      .isArray({ max: 50 })
      .withMessage("registrationFields options must be an array"),
    body("assignedUsers")
      .optional()
      .isArray()
      .withMessage("Assigned users must be an array"),
    validate,
  ],
  updateEvent,
);

/**
 * @route   DELETE /api/events/:id
 * @desc    Delete event
 * @access  Private/Admin
 */
router.delete(
  "/:id",
  adminOnly,
  [commonValidations.mongoId("id"), validate],
  deleteEvent,
);

export default router;
