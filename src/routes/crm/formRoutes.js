import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { ApiError } from "../../utils/apiResponse.js";
import { publicFormFetchLimiter } from "../../middlewares/rateLimiter.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  getForms,
  getForm,
  getPublicForm,
  createForm,
  updateForm,
  deleteForm,
  restoreForm,
  duplicateForm,
} from "../../controllers/crm/formController.js";

const router = express.Router();

// ── Public route (no auth) ──────────────────────────────
// Rate-limited per-IP to prevent scraping + burst abuse
// Tenant slug required to prevent cross-tenant form leaks
router.get(
  "/public/:tenantSlug/:apiName",
  publicFormFetchLimiter,
  getPublicForm,
);
// Backward-compat: bare apiName route returns 400 with migration hint
router.get("/public/:apiName", (req, res, next) => {
  next(
    ApiError.badRequest(
      "Tenant slug is required. Use /public/:tenantSlug/:apiName",
    ),
  );
});

// ── Authenticated routes ────────────────────────────────
router.use(protect);
router.use(requirePlanFeature("crmAdvanced"));

router.get("/", authorize("admin", "marketing"), getForms);
router.get("/:id", authorize("admin", "marketing"), validateMongoId(), getForm);
router.post("/", authorize("admin"), createForm);
router.put("/:id", authorize("admin"), validateMongoId(), updateForm);
router.delete("/:id", authorize("admin"), validateMongoId(), deleteForm);
router.patch(
  "/:id/restore",
  authorize("admin"),
  validateMongoId(),
  restoreForm,
);
router.post(
  "/:id/duplicate",
  authorize("admin"),
  validateMongoId(),
  duplicateForm,
);

export default router;
