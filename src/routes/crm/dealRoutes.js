import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getDeals,
  getDeal,
  createDeal,
  updateDeal,
  changeDealStage,
  deleteDeal,
  restoreDeal,
  assignDealOwner,
} from "../../controllers/crm/dealController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getDeals);
router.get("/:id", validateMongoId(), getDeal);
router.post("/", authorize("admin", "marketing"), createDeal);
router.put(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  updateDeal,
);
router.patch(
  "/:id/stage",
  authorize("admin", "marketing"),
  validateMongoId(),
  changeDealStage,
);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteDeal);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreDeal,
);
router.patch(
  "/:id/assign",
  authorize("admin"),
  validateMongoId(),
  assignDealOwner,
);

export default router;
