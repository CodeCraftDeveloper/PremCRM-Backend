import express from "express";
import { query } from "express-validator";
import {
  exportClients,
  exportEvents,
  exportActivityLogs,
  getExportSummary,
  exportLeads,
  exportLeadsSummary,
} from "../controllers/exportController.js";
import { protect, adminOnly, authorize } from "../middlewares/auth.js";
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

/**
 * @route   GET /api/export/leads
 * @desc    Export leads/queries to Excel (XLSX) with optional grouping by website
 * @access  Private (admin, marketing)
 */
router.get(
  "/leads",
  authorize("admin", "marketing"),
  [
    query("status")
      .optional()
      .isIn(["new", "contacted", "interested", "qualified", "closed", "lost"])
      .withMessage("Invalid status"),
    query("websiteId").optional().isMongoId().withMessage("Invalid website ID"),
    query("assignedTo").optional().isMongoId().withMessage("Invalid user ID"),
    query("startDate").optional().isISO8601().withMessage("Invalid start date"),
    query("endDate").optional().isISO8601().withMessage("Invalid end date"),
    query("groupByWebsite")
      .optional()
      .isIn(["true", "false"])
      .withMessage("groupByWebsite must be true or false"),
    validate,
  ],
  exportLeads,
);

/**
 * @route   GET /api/export/leads/summary
 * @desc    Export website query summary to Excel
 * @access  Private/Admin
 */
router.get("/leads/summary", adminOnly, exportLeadsSummary);

export default router;
