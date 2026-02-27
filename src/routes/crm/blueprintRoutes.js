import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getBlueprints,
  getBlueprint,
  createBlueprint,
  updateBlueprint,
  deleteBlueprint,
  validateTransition,
} from "../../controllers/crm/blueprintController.js";

const router = express.Router();

router.use(protect);

router.get(
  "/",
  authorize("admin", "marketing"),
  validatePagination(),
  getBlueprints,
);
router.get(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  getBlueprint,
);
router.post("/", authorize("admin"), createBlueprint);
router.put("/:id", authorize("admin"), validateMongoId(), updateBlueprint);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteBlueprint);
router.post("/validate", authorize("admin", "marketing"), validateTransition);

export default router;
