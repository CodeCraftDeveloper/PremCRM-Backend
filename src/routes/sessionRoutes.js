import express from "express";
import {
  getMarketingUsersStatus,
  getMarketingPerformance,
  getMyMarketingPerformance,
  getMarketingUserDetailedReport,
} from "../controllers/sessionController.js";
import { protect, authorize } from "../middlewares/auth.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/sessions/marketing/status
 * @desc    Get all marketing users online/offline status (Admin only)
 * @access  Private (Admin)
 */
router.get(
  "/marketing/status",
  authorize("admin", "superadmin"),
  getMarketingUsersStatus,
);

/**
 * @route   GET /api/sessions/marketing/performance
 * @desc    Get marketing user performance metrics (Admin only)
 * @access  Private (Admin)
 * @query   startDate, endDate, userId
 */
router.get(
  "/marketing/performance",
  authorize("admin", "superadmin"),
  getMarketingPerformance,
);

/**
 * @route   GET /api/sessions/marketing/my-performance
 * @desc    Get current marketing user's performance
 * @access  Private (Marketing)
 */
router.get(
  "/marketing/my-performance",
  authorize("admin", "superadmin", "marketing"),
  getMyMarketingPerformance,
);

/**
 * @route   GET /api/sessions/marketing/:userId/report
 * @desc    Get detailed report for a marketing user (Admin only)
 * @access  Private (Admin)
 * @query   days (default: 30)
 */
router.get(
  "/marketing/:userId/report",
  authorize("admin", "superadmin"),
  getMarketingUserDetailedReport,
);

export default router;
