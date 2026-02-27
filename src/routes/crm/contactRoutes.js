import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  restoreContact,
  assignContactOwner,
} from "../../controllers/crm/contactController.js";

const router = express.Router();

router.use(protect);

router.get("/", validatePagination(), getContacts);
router.get("/:id", validateMongoId(), getContact);
router.post("/", authorize("admin", "marketing"), createContact);
router.put(
  "/:id",
  authorize("admin", "marketing"),
  validateMongoId(),
  updateContact,
);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteContact);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreContact,
);
router.patch(
  "/:id/assign",
  authorize("admin"),
  validateMongoId(),
  assignContactOwner,
);

export default router;
