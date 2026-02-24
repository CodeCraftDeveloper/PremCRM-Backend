import express from "express";
import { query } from "express-validator";
import {
  exportClients,
  exportEvents,
  exportActivityLogs,
  getExportSummary,
} from "../controllers/exportController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { exportLimiter } from "../middlewares/rateLimiter.js";
import { validate } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);
router.use(exportLimiter);

/**
 * @route   GET /api/export/summary
 * @desc    Get export summary/options
 * @access  Private
 */
router.get("/summary", getExportSummary);

/**
 * @route   GET /api/export/clients
 * @desc    Export clients to CSV
 * @access  Private
 */
router.get(
  "/clients",
  [
    query("event").optional().isMongoId().withMessage("Invalid event ID"),
    query("marketingPerson")
      .optional()
      .isMongoId()
      .withMessage("Invalid marketing person ID"),
    query("followUpStatus")
      .optional()
      .isIn([
        "new",
        "contacted",
        "interested",
        "negotiation",
        "converted",
        "lost",
      ])
      .withMessage("Invalid follow-up status"),
    query("startDate").optional().isISO8601().withMessage("Invalid start date"),
    query("endDate").optional().isISO8601().withMessage("Invalid end date"),
    validate,
  ],
  exportClients,
);

/**
 * @route   GET /api/export/events
 * @desc    Export events to CSV
 * @access  Private/Admin
 */
router.get(
  "/events",
  adminOnly,
  [
    query("status")
      .optional()
      .isIn(["upcoming", "active", "completed", "cancelled"])
      .withMessage("Invalid status"),
    validate,
  ],
  exportEvents,
);

/**
 * @route   GET /api/export/activity-logs
 * @desc    Export activity logs to CSV
 * @access  Private/Admin
 */
router.get(
  "/activity-logs",
  adminOnly,
  [
    query("userId").optional().isMongoId().withMessage("Invalid user ID"),
    query("startDate").optional().isISO8601().withMessage("Invalid start date"),
    query("endDate").optional().isISO8601().withMessage("Invalid end date"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 10000 })
      .withMessage("Limit must be 1-10000"),
    validate,
  ],
  exportActivityLogs,
);

export default router;
