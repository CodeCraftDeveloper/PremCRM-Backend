import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  updatePipelineStages,
} from "../../controllers/crm/pipelineController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getPipelines);
router.get("/:id", validateMongoId(), getPipeline);
router.post("/", authorize("admin"), createPipeline);
router.put("/:id", authorize("admin"), validateMongoId(), updatePipeline);
router.put(
  "/:id/stages",
  authorize("admin"),
  validateMongoId(),
  updatePipelineStages,
);

export default router;
