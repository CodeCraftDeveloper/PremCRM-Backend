import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getActivities,
  getActivity,
  getActivitiesForEntity,
  createActivity,
  updateActivity,
  deleteActivity,
  restoreActivity,
} from "../../controllers/crm/crmActivityController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getActivities);
router.get(
  "/entity/:entityType/:entityId",
  validateMongoId("entityId"),
  getActivitiesForEntity,
);
router.get("/:id", validateMongoId(), getActivity);
router.post("/", authorize("admin", "marketing"), createActivity);
router.put(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  updateActivity,
);
router.delete(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  deleteActivity,
);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreActivity,
);

export default router;
