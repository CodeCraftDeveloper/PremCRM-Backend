import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
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

router.get("/snapshot", snapshot);
router.get("/funnel/:pipelineId", validateMongoId("pipelineId"), dealFunnel);
router.get("/lead-source", leadSourcePerformance);
router.get("/owner-performance", authorize("admin"), ownerPerformance);
router.get(
  "/stage-duration/:pipelineId",
  validateMongoId("pipelineId"),
  stageDuration,
);

export default router;
