import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  dealFunnel,
  leadSourcePerformance,
  ownerPerformance,
  stageDuration,
  snapshot,
} from "../../controllers/crm/crmAnalyticsController.js";

const router = express.Router();

router.use(protect);
router.use(authorize("admin", "marketing"));

// Basic snapshot is available to all plans (analyticsBasic)
router.get("/snapshot", snapshot);

// Advanced analytics endpoints require analyticsAdvanced (growth+)
const advanced = requirePlanFeature("analyticsAdvanced");
router.get("/funnel/:pipelineId", advanced, validateMongoId("pipelineId"), dealFunnel);
router.get("/lead-source", advanced, leadSourcePerformance);
router.get("/owner-performance", advanced, authorize("admin"), ownerPerformance);
router.get(
  "/stage-duration/:pipelineId",
  advanced,
  validateMongoId("pipelineId"),
  stageDuration,
);

export default router;
