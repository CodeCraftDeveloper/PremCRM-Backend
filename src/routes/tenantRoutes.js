import express from "express";
import { body } from "express-validator";
import {
  bootstrapTenant,
  getTenants,
  getTenantById,
  updateTenantById,
} from "../controllers/tenantController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

router.post(
  "/bootstrap",
  [
    body("tenantName")
      .trim()
      .notEmpty()
      .withMessage("tenantName is required")
      .isLength({ min: 2, max: 120 })
      .withMessage("tenantName must be 2-120 characters"),
    body("slug")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^[a-z0-9-]{2,80}$/)
      .withMessage(
        "slug can contain lowercase letters, numbers, and hyphens only",
      ),
    body("adminName")
      .trim()
      .notEmpty()
      .withMessage("adminName is required")
      .isLength({ min: 2, max: 100 })
      .withMessage("adminName must be 2-100 characters"),
    commonValidations.email("adminEmail"),
    commonValidations.password("adminPassword"),
    body("companyName")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 200 })
      .withMessage("companyName cannot exceed 200 characters"),
    body("companyRef")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("companyRef cannot exceed 100 characters"),
    validate,
  ],
  bootstrapTenant,
);

router.use(protect, adminOnly);

router.get("/", getTenants);
router.get("/:id", [commonValidations.mongoId("id"), validate], getTenantById);
router.put(
  "/:id",
  [
    commonValidations.mongoId("id"),
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 120 })
      .withMessage("name must be 2-120 characters"),
    body("plan")
      .optional()
      .isIn(["free", "pro", "enterprise"])
      .withMessage("Invalid plan"),
    body("isActive")
      .optional()
      .isBoolean()
      .withMessage("isActive must be boolean"),
    body("settings").optional().isObject().withMessage("settings must be object"),
    body("company").optional().isObject().withMessage("company must be an object"),
    body("company.name")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("company.name cannot exceed 200 characters"),
    body("company.referenceId")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("company.referenceId cannot exceed 100 characters"),
    validate,
  ],
  updateTenantById,
);

export default router;
