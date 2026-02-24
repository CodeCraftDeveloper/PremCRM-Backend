import express from "express";
import { body } from "express-validator";
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  getMarketingUsers,
} from "../controllers/userController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/users/marketing
 * @desc    Get marketing users (for dropdowns)
 * @access  Private
 */
router.get("/marketing", getMarketingUsers);

/**
 * @route   GET /api/users
 * @desc    Get all users
 * @access  Private/Admin
 */
router.get(
  "/",
  adminOnly,
  [...commonValidations.pagination(), validate],
  getUsers,
);

/**
 * @route   GET /api/users/:id
 * @desc    Get single user
 * @access  Private/Admin
 */
router.get(
  "/:id",
  adminOnly,
  [commonValidations.mongoId("id"), validate],
  getUser,
);

/**
 * @route   POST /api/users
 * @desc    Create user
 * @access  Private/Admin
 */
router.post(
  "/",
  adminOnly,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    commonValidations.email(),
    commonValidations.password(),
    body("role")
      .optional()
      .isIn(["admin", "marketing"])
      .withMessage("Role must be admin or marketing"),
    commonValidations.phone("phone"),
    validate,
  ],
  createUser,
);

/**
 * @route   PUT /api/users/:id
 * @desc    Update user
 * @access  Private/Admin
 */
router.put(
  "/:id",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    body("email").optional().isEmail().withMessage("Invalid email"),
    body("role")
      .optional()
      .isIn(["admin", "marketing"])
      .withMessage("Role must be admin or marketing"),
    body("isActive")
      .optional()
      .isBoolean()
      .withMessage("isActive must be boolean"),
    commonValidations.phone("phone"),
    validate,
  ],
  updateUser,
);

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete user
 * @access  Private/Admin
 */
router.delete(
  "/:id",
  adminOnly,
  [commonValidations.mongoId("id"), validate],
  deleteUser,
);

/**
 * @route   PUT /api/users/:id/reset-password
 * @desc    Reset user password (by admin)
 * @access  Private/Admin
 */
router.put(
  "/:id/reset-password",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    commonValidations.password("newPassword"),
    validate,
  ],
  resetUserPassword,
);

export default router;
