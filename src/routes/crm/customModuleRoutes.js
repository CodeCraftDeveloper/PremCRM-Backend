import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getCustomModules,
  getCustomModule,
  getCustomModuleByName,
  createCustomModule,
  updateCustomModule,
  deleteCustomModule,
  restoreCustomModule,
  toggleCustomModule,
} from "../../controllers/crm/customModuleController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("customFields"));

router.get(
  "/",
  authorize("admin", "marketing"),
  validatePagination(),
  getCustomModules,
);
router.get(
  "/by-name/:apiName",
  authorize("admin", "marketing"),
  getCustomModuleByName,
);
router.get(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  getCustomModule,
);
router.post("/", authorize("admin"), createCustomModule);
router.put("/:id", authorize("admin"), validateMongoId(), updateCustomModule);
router.delete(
  "/:id",
  authorize("admin"),
  validateMongoId(),
  deleteCustomModule,
);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreCustomModule,
);
router.patch(
  "/:id/toggle",
  authorize("admin"),
  validateMongoId(),
  toggleCustomModule,
);

export default router;
