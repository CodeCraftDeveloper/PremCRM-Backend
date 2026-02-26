import express from "express";
import { body, param, query } from "express-validator";
import { protect, authorize } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";
import {
  getPlatformDashboard,
  getAllTenants,
  getTenantDetail,
  createTenant,
  updateTenant,
  deleteTenant,
  getAllUsers,
  toggleUserActive,
  changeUserRole,
  getPlatformActivity,
} from "../controllers/superAdminController.js";

const router = express.Router();

// All routes require superadmin role
router.use(protect, authorize("superadmin"));

// ─── Dashboard ───────────────────────────────────────────────────────────────
router.get("/dashboard", getPlatformDashboard);

// ─── Tenant Management ───────────────────────────────────────────────────────
router.get("/tenants", getAllTenants);

router.get(
  "/tenants/:id",
  [commonValidations.mongoId("id"), validate],
  getTenantDetail,
);

router.post(
  "/tenants",
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Tenant name is required")
      .isLength({ min: 2, max: 120 }),
    body("slug")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^[a-z0-9-]{2,80}$/),
    body("companyName").optional({ checkFalsy: true }).trim(),
    body("companyRef").optional({ checkFalsy: true }).trim(),
    body("plan").optional().isIn(["free", "pro", "enterprise"]),
    body("adminName").optional({ checkFalsy: true }).trim(),
    body("adminEmail").optional({ checkFalsy: true }).isEmail(),
    body("adminPassword").optional({ checkFalsy: true }).isLength({ min: 8 }),
    body("settings").optional().isObject(),
    validate,
  ],
  createTenant,
);

router.put(
  "/tenants/:id",
  [
    commonValidations.mongoId("id"),
    body("name").optional().trim().isLength({ min: 2, max: 120 }),
    body("plan").optional().isIn(["free", "pro", "enterprise"]),
    body("isActive").optional().isBoolean(),
    body("settings").optional().isObject(),
    body("company").optional().isObject(),
    body("allowedRoles").optional().isArray(),
    validate,
  ],
  updateTenant,
);

router.delete(
  "/tenants/:id",
  [commonValidations.mongoId("id"), validate],
  deleteTenant,
);

// ─── User Management (Cross-Tenant) ─────────────────────────────────────────
router.get("/users", getAllUsers);

router.put(
  "/users/:id/toggle-active",
  [commonValidations.mongoId("id"), validate],
  toggleUserActive,
);

router.put(
  "/users/:id/role",
  [
    commonValidations.mongoId("id"),
    body("role")
      .isIn(["admin", "marketing", "user"])
      .withMessage("Invalid role"),
    validate,
  ],
  changeUserRole,
);

// ─── Platform Activity ───────────────────────────────────────────────────────
router.get("/activity", getPlatformActivity);

export default router;
