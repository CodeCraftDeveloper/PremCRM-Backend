import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  restoreAccount,
  assignAccountOwner,
} from "../../controllers/crm/accountController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getAccounts);
router.get("/:id", validateMongoId(), getAccount);
router.post("/", authorize("admin", "marketing"), createAccount);
router.put(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  updateAccount,
);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteAccount);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreAccount,
);
router.patch(
  "/:id/assign",
  authorize("admin"),
  validateMongoId(),
  assignAccountOwner,
);

export default router;
