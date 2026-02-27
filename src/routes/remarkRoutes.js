import express from "express";
import { body } from "express-validator";
import { updateRemark, deleteRemark } from "../controllers/remarkController.js";
import { protect, authorize } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   PUT /api/remarks/:id
 * @desc    Update a remark
 * @access  Private
 */
router.put(
  "/:id",
  authorize("admin", "marketing"),
  [
    commonValidations.mongoId("id"),
    body("content")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Remark cannot exceed 2000 characters"),
    body("isPinned")
      .optional()
      .isBoolean()
      .withMessage("isPinned must be boolean"),
    validate,
  ],
  updateRemark,
);

/**
 * @route   DELETE /api/remarks/:id
 * @desc    Delete a remark
 * @access  Private
 */
router.delete(
  "/:id",
  authorize("admin", "marketing"),
  [commonValidations.mongoId("id"), validate],
  deleteRemark,
);

export default router;
