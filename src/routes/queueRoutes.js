import express from "express";
import {
  getQueuesStatus,
  getFailedJobs,
} from "../controllers/queueStatusController.js";
import {
  protect,
  adminOnly,
  superAdminOnly,
} from "../middlewares/auth.js";

const router = express.Router();

// All queue endpoints require auth.
router.use(protect);

/**
 * GET /api/v1/queues/status
 * Superadmin only — system-wide queue health (per-queue counts + retry policy).
 */
router.get("/status", superAdminOnly, getQueuesStatus);

/**
 * GET /api/v1/queues/failed-jobs
 * Tenant admin: own tenant only. Superadmin: any tenant (or whole system).
 */
router.get("/failed-jobs", adminOnly, getFailedJobs);

export default router;
