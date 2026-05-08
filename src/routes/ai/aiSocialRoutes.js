/**
 * AI Social Content routes (P7-002).
 *
 * Mounted at:
 *   - /api/v1/ai/social
 *   - /api/ai/social   (backward-compat)
 *
 * All endpoints require:
 *   - `protect` (authenticated tenant user)
 *   - `requirePlanFeature("aiSocialContent")` (currently agency+/enterprise)
 *
 * Brand profile mutations and approval decisions are admin-only.
 * Marketing roles can read brand profile, generate drafts, and read drafts.
 */

import express from "express";
import { authorize, protect } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  approveSocialDraft,
  generateSocialDraft,
  getBrandProfile,
  getSocialDraft,
  listSocialDrafts,
  rejectSocialDraft,
  upsertBrandProfile,
} from "../../controllers/ai/aiSocialController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("aiSocialContent"));

// ── Brand profile (tenant business facts) ───────────────────────────
router.get(
  "/brand-profile",
  authorize("admin", "superadmin", "marketing"),
  getBrandProfile,
);

router.put(
  "/brand-profile",
  authorize("admin", "superadmin"),
  upsertBrandProfile,
);

// ── Drafts ──────────────────────────────────────────────────────────
router.post(
  "/drafts",
  authorize("admin", "superadmin", "marketing"),
  generateSocialDraft,
);

router.get(
  "/drafts",
  authorize("admin", "superadmin", "marketing"),
  listSocialDrafts,
);

router.get(
  "/drafts/:id",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId(),
  getSocialDraft,
);

router.post(
  "/drafts/:id/approve",
  authorize("admin", "superadmin"),
  validateMongoId(),
  approveSocialDraft,
);

router.post(
  "/drafts/:id/reject",
  authorize("admin", "superadmin"),
  validateMongoId(),
  rejectSocialDraft,
);

export default router;
