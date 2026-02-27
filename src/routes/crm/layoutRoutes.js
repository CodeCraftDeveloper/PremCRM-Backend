import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getLayouts,
  getLayout,
  getActiveLayout,
  upsertLayout,
  updateLayout,
  deleteLayout,
  addLayoutSection,
  reorderLayoutSections,
} from "../../controllers/crm/layoutController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getLayouts);
router.get("/active/:moduleApiName/:layoutType", getActiveLayout);
router.get("/:id", validateMongoId(), getLayout);
router.post("/", authorize("admin"), upsertLayout);
router.put("/:id", authorize("admin"), validateMongoId(), updateLayout);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteLayout);
router.post(
  "/:id/sections",
  authorize("admin"),
  validateMongoId(),
  addLayoutSection,
);
router.patch(
  "/:id/sections/reorder",
  authorize("admin"),
  validateMongoId(),
  reorderLayoutSections,
);

export default router;
