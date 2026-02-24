import express from "express";
import {
  getAdminDashboard,
  getMarketingDashboard,
  getAnalytics,
} from "../controllers/dashboardController.js";
import { protect, adminOnly, marketingOrAdmin } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/dashboard/admin
 * @desc    Get admin dashboard data
 * @access  Private/Admin
 */
router.get("/admin", adminOnly, getAdminDashboard);

/**
 * @route   GET /api/dashboard/marketing
 * @desc    Get marketing user dashboard data
 * @access  Private
 */
router.get("/marketing", getMarketingDashboard);

/**
 * @route   GET /api/dashboard/analytics
 * @desc    Get dashboard analytics
 * @access  Private/Admin
 */
router.get(
  "/analytics",
  adminOnly,
  [...commonValidations.pagination(), validate],
  getAnalytics,
);

export default router;
