/**
 * Workflow v2 API routes (P3-005).
 *
 * Mounted at `/api/v1/crm/workflows/v2` by the CRM route index.
 * All routes require authentication and the `workflowBuilder` plan feature.
 */

import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  listWorkflowsV2,
  getWorkflowV2,
  createWorkflowV2,
  updateWorkflowV2,
  deleteWorkflowV2,
  getRegistry,
  getWorkflowRuns,
  activateWorkflowV2,
} from "../../controllers/crm/workflowV2Controller.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("workflowBuilder"));

// Registry (palette data for builder UI) — must be before /:id routes
router.get("/registry", authorize("admin"), getRegistry);

// CRUD
router.get("/", authorize("admin"), validatePagination(), listWorkflowsV2);
router.post("/", authorize("admin"), createWorkflowV2);
router.get("/:id", authorize("admin"), validateMongoId(), getWorkflowV2);
router.put("/:id", authorize("admin"), validateMongoId(), updateWorkflowV2);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteWorkflowV2);

// Activate / deactivate
router.put("/:id/activate", authorize("admin"), validateMongoId(), activateWorkflowV2);

// Run history
router.get("/:id/runs", authorize("admin"), validateMongoId(), validatePagination(), getWorkflowRuns);

export default router;
