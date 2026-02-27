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
  // Step 1 — Tenant Operations
  suspendTenant,
  reactivateTenant,
  getTenantHealth,
  forceLogoutTenant,
  // Step 2 — Audit Logging
  getAuditLogs,
  // Step 3 — Usage Tracking
  getTenantUsage,
  // Step 4 — Soft Delete Management
  getDeletedRecords,
  hardDelete,
  // Step 5 & 6 — Tenant Settings & Feature Flags
  getTenantSettings,
  updateTenantSettings,
  updateFeatureFlags,
  // Step 7 — Index Report
  getIndexReport,
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

// ─── Tenant Operations (Step 1) ─────────────────────────────────────────────

router.post(
  "/tenants/:id/suspend",
  [
    commonValidations.mongoId("id"),
    body("reason")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Reason cannot exceed 500 characters"),
    validate,
  ],
  suspendTenant,
);

router.post(
  "/tenants/:id/reactivate",
  [commonValidations.mongoId("id"), validate],
  reactivateTenant,
);

router.get(
  "/tenants/:id/health",
  [commonValidations.mongoId("id"), validate],
  getTenantHealth,
);

router.post(
  "/tenants/:id/force-logout",
  [commonValidations.mongoId("id"), validate],
  forceLogoutTenant,
);

// ─── Tenant Usage (Step 3) ──────────────────────────────────────────────────

router.get(
  "/tenants/:id/usage",
  [
    commonValidations.mongoId("id"),
    query("days")
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage("Days must be between 1 and 365"),
    validate,
  ],
  getTenantUsage,
);

// ─── Tenant Settings (Step 5) ───────────────────────────────────────────────

router.get(
  "/tenants/:id/settings",
  [commonValidations.mongoId("id"), validate],
  getTenantSettings,
);

router.put(
  "/tenants/:id/settings",
  [
    commonValidations.mongoId("id"),
    body("leadStatusPipeline").optional().isArray(),
    body("customFields").optional().isObject(),
    body("sla").optional().isObject(),
    body("assignmentRules").optional().isObject(),
    body("features").optional().isObject(),
    validate,
  ],
  updateTenantSettings,
);

// ─── Feature Flags (Step 6) ─────────────────────────────────────────────────

router.put(
  "/tenants/:id/features",
  [
    commonValidations.mongoId("id"),
    body("features")
      .notEmpty()
      .isObject()
      .withMessage("Features object is required"),
    validate,
  ],
  updateFeatureFlags,
);

// ─── Soft Delete Management (Step 4) ────────────────────────────────────────

router.get(
  "/tenants/:id/deleted",
  [
    commonValidations.mongoId("id"),
    query("type").optional().isIn(["all", "leads", "clients"]),
    validate,
  ],
  getDeletedRecords,
);

router.delete(
  "/hard-delete/:entityType/:entityId",
  [
    param("entityType")
      .isIn(["lead", "client"])
      .withMessage("Entity type must be 'lead' or 'client'"),
    param("entityId").isMongoId().withMessage("Invalid entity ID"),
    query("tenantId")
      .notEmpty()
      .withMessage("tenantId query parameter is required")
      .isMongoId()
      .withMessage("Invalid tenant ID"),
    query("confirm")
      .optional()
      .equals("PERMANENT_DELETE")
      .withMessage("confirm must be 'PERMANENT_DELETE'"),
    validate,
  ],
  hardDelete,
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

// ─── Audit Logs (Step 2) ────────────────────────────────────────────────────
router.get("/audit-logs", getAuditLogs);

// ─── Index Report (Step 7) ──────────────────────────────────────────────────
router.get("/index-report", getIndexReport);

export default router;
