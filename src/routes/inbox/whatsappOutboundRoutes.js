/**
 * WhatsApp outbound (draft + approval + send) and template registry API.
 */

import express from "express";
import { authorize, protect } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  handleUploadError,
  uploadWhatsappMedia,
} from "../../middlewares/upload.js";
import {
  approveWhatsappDraft,
  createWhatsappDraft,
  createWhatsappMediaDraft,
  createWhatsappTemplateDraft,
  getWhatsappWindowStatus,
  listWhatsappApprovals,
  rejectWhatsappDraft,
} from "../../controllers/inbox/whatsappOutboundController.js";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  upsertTemplate,
} from "../../controllers/inbox/whatsappTemplateController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("whatsappIntegration"));

// ── Approval / draft ────────────────────────────────────────
router.post(
  "/conversations/:conversationId/draft",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  createWhatsappDraft,
);

router.post(
  "/conversations/:conversationId/media-draft",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  uploadWhatsappMedia,
  handleUploadError,
  createWhatsappMediaDraft,
);

router.post(
  "/conversations/:conversationId/template-draft",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  createWhatsappTemplateDraft,
);

router.get(
  "/conversations/:conversationId/window",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  getWhatsappWindowStatus,
);

router.get(
  "/approvals",
  authorize("admin", "superadmin", "marketing"),
  listWhatsappApprovals,
);

router.post(
  "/approvals/:id/approve",
  authorize("admin", "superadmin"),
  validateMongoId(),
  approveWhatsappDraft,
);

router.post(
  "/approvals/:id/reject",
  authorize("admin", "superadmin"),
  validateMongoId(),
  rejectWhatsappDraft,
);

// ── Template registry ───────────────────────────────────────
router.get(
  "/templates",
  authorize("admin", "superadmin", "marketing"),
  listTemplates,
);

router.post(
  "/templates",
  authorize("admin", "superadmin"),
  upsertTemplate,
);

router.get(
  "/templates/:id",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId(),
  getTemplate,
);

router.delete(
  "/templates/:id",
  authorize("admin", "superadmin"),
  validateMongoId(),
  deleteTemplate,
);

export default router;
