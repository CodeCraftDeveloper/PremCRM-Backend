import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getCustomFields,
  getFieldsByModule,
  getModuleMetadata,
  getCustomField,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  restoreCustomField,
  reorderCustomFields,
  validateCustomData,
  resolveReferences,
} from "../../controllers/crm/customFieldController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("customFields"));

router.get(
  "/",
  authorize("admin", "marketing"),
  validatePagination(),
  getCustomFields,
);
router.get(
  "/module/:moduleApiName",
  authorize("admin", "marketing"),
  getFieldsByModule,
);
router.get(
  "/module/:moduleApiName/metadata",
  authorize("admin", "marketing"),
  getModuleMetadata,
);
router.get(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  getCustomField,
);
router.post("/", authorize("admin"), createCustomField);
router.put("/:id", authorize("admin"), validateMongoId(), updateCustomField);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteCustomField);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreCustomField,
);
router.patch(
  "/module/:moduleApiName/reorder",
  authorize("admin"),
  reorderCustomFields,
);
router.post(
  "/module/:moduleApiName/validate",
  authorize("admin", "marketing"),
  validateCustomData,
);
router.post(
  "/module/:moduleApiName/resolve",
  authorize("admin", "marketing"),
  resolveReferences,
);

export default router;
