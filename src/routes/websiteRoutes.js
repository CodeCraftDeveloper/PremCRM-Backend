import express from "express";
import { body, param, query } from "express-validator";
import {
  getWebsites,
  getWebsiteDetail,
  createWebsite,
  updateWebsite,
  regenerateApiKey,
  getWebsiteStats,
  testWebsiteConnection,
  deleteWebsite,
} from "../controllers/websiteController.js";
import { protect, authorize } from "../middlewares/auth.js";
import { validate } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/websites
 * @desc    Get all websites
 * @access  Private
 */
router.get(
  "/",
  [
    query("isActive")
      .optional()
      .isBoolean()
      .withMessage("isActive must be a boolean"),
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    validate,
  ],
  getWebsites,
);

/**
 * @route   POST /api/websites
 * @desc    Create new website
 * @access  Private (admin)
 */
router.post(
  "/",
  authorize("admin", "superadmin"),
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ min: 1, max: 100 })
      .withMessage("Name must be 1-100 characters"),
    body("domain")
      .trim()
      .notEmpty()
      .withMessage("Domain is required")
      .isLength({ min: 3, max: 255 })
      .withMessage("Domain must be 3-255 characters"),
    body("category")
      .optional()
      .isIn(["contact_form", "landing_page", "webinar", "partner", "other"])
      .withMessage("Invalid category"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Description must not exceed 500 characters"),
    body("webhookUrl")
      .optional({ checkFalsy: true })
      .trim()
      .isURL()
      .withMessage("Invalid webhook URL"),
    body("duplicateSettings.checkEmail")
      .optional()
      .isBoolean()
      .withMessage("checkEmail must be a boolean"),
    body("duplicateSettings.checkPhone")
      .optional()
      .isBoolean()
      .withMessage("checkPhone must be a boolean"),
    body("rateLimit.requestsPerMinute")
      .optional()
      .isInt({ min: 1, max: 10000 })
      .withMessage("Requests per minute must be 1-10000"),
    validate,
  ],
  createWebsite,
);

/**
 * @route   GET /api/websites/:id
 * @desc    Get website details
 * @access  Private
 */
router.get(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid website ID"), validate],
  getWebsiteDetail,
);

/**
 * @route   PUT /api/websites/:id
 * @desc    Update website
 * @access  Private (admin)
 */
router.put(
  "/:id",
  authorize("admin", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid website ID"),
    body("name")
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Name must be 1-100 characters"),
    body("category")
      .optional()
      .isIn(["contact_form", "landing_page", "webinar", "partner", "other"])
      .withMessage("Invalid category"),
    body("isActive")
      .optional()
      .isBoolean()
      .withMessage("isActive must be a boolean"),
    validate,
  ],
  updateWebsite,
);

/**
 * @route   POST /api/websites/:id/regenerate-key
 * @desc    Regenerate API key
 * @access  Private (admin)
 */
router.post(
  "/:id/regenerate-key",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid website ID"), validate],
  regenerateApiKey,
);

/**
 * @route   GET /api/websites/:id/stats
 * @desc    Get website statistics
 * @access  Private
 */
router.get(
  "/:id/stats",
  [param("id").isMongoId().withMessage("Invalid website ID"), validate],
  getWebsiteStats,
);

/**
 * @route   POST /api/websites/:id/test
 * @desc    Test webhook connection
 * @access  Private
 */
router.post(
  "/:id/test",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid website ID"), validate],
  testWebsiteConnection,
);

/**
 * @route   DELETE /api/websites/:id
 * @desc    Delete website
 * @access  Private (admin)
 */
router.delete(
  "/:id",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid website ID"), validate],
  deleteWebsite,
);

export default router;
