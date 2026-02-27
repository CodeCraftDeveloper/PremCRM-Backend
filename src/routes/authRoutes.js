import express from "express";
import { body } from "express-validator";
import {
  login,
  refreshAccessToken,
  logout,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  registerMarketingManager,
  createInvite,
  acceptInvite,
} from "../controllers/authController.js";
import { protect, authorize } from "../middlewares/auth.js";
import { getCsrfToken } from "../middlewares/csrf.js";
import {
  authLimiter,
  passwordResetLimiter,
} from "../middlewares/rateLimiter.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

/**
 * @route   GET /api/auth/csrf-token
 * @desc    Get a CSRF token (sets csrf-token cookie + returns token in body)
 * @access  Public
 */
router.get("/csrf-token", getCsrfToken);

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post(
  "/login",
  authLimiter,
  [
    commonValidations.email(),
    body("password").notEmpty().withMessage("Password is required"),
    body("tenantSlug")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^[a-z0-9-]{2,80}$/)
      .withMessage(
        "tenantSlug can contain lowercase letters, numbers, and hyphens only",
      ),
    validate,
  ],
  login,
);

/**
 * @route   POST /api/auth/register-marketing-manager
 * @desc    Register a marketing manager account
 * @access  Public
 */
router.post(
  "/register-marketing-manager",
  authLimiter,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    commonValidations.email(),
    commonValidations.password(),
    commonValidations.phone("phone"),
    body("tenantSlug")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^[a-z0-9-]{2,80}$/)
      .withMessage(
        "Company ID can contain lowercase letters, numbers, and hyphens only",
      ),
    validate,
  ],
  registerMarketingManager,
);

/**
 * @route   POST /api/auth/refresh-token
 * @desc    Refresh access token
 * @access  Public
 */
router.post(
  "/refresh-token",
  [
    body("refreshToken")
      .optional()
      .notEmpty()
      .withMessage("Refresh token cannot be empty"),
    validate,
  ],
  refreshAccessToken,
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post("/logout", protect, logout);

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile
 * @access  Private
 */
router.get("/me", protect, getMe);

/**
 * @route   PUT /api/auth/me
 * @desc    Update current user profile
 * @access  Private
 */
router.put(
  "/me",
  protect,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    commonValidations.phone("phone"),
    validate,
  ],
  updateProfile,
);

/**
 * @route   PUT /api/auth/change-password
 * @desc    Change password
 * @access  Private
 */
router.put(
  "/change-password",
  protect,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    commonValidations.password("newPassword"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Confirm password is required")
      .custom((value, { req }) => value === req.body.newPassword)
      .withMessage("Passwords do not match"),
    validate,
  ],
  changePassword,
);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset
 * @access  Public
 */
router.post(
  "/forgot-password",
  passwordResetLimiter,
  [commonValidations.email(), validate],
  forgotPassword,
);

/**
 * @route   POST /api/auth/reset-password/:token
 * @desc    Reset password
 * @access  Public
 */
router.post(
  "/reset-password/:token",
  passwordResetLimiter,
  [
    commonValidations.password("password"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Confirm password is required")
      .custom((value, { req }) => value === req.body.password)
      .withMessage("Passwords do not match"),
    validate,
  ],
  resetPassword,
);

/**
 * @route   POST /api/auth/invites
 * @desc    Create user invite (Admin only)
 * @access  Private (Admin/SuperAdmin)
 */
router.post(
  "/invites",
  protect,
  authorize("admin", "superadmin"),
  [
    commonValidations.email("email"),
    body("role")
      .notEmpty()
      .withMessage("Role is required")
      .isIn(["admin", "marketing", "user"])
      .withMessage("Invalid role"),
    validate,
  ],
  createInvite,
);

/**
 * @route   POST /api/auth/invites/:token/accept
 * @desc    Accept user invite and create account
 * @access  Public
 */
router.post(
  "/invites/:token/accept",
  authLimiter,
  [
    commonValidations.password("password"),
    body("userName")
      .trim()
      .notEmpty()
      .withMessage("User name is required")
      .isLength({ min: 2, max: 100 })
      .withMessage("User name must be 2-100 characters"),
    validate,
  ],
  acceptInvite,
);

export default router;
