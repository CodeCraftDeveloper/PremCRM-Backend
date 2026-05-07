/**
 * gmailOutboundRoutes.js — Gmail outbound (draft + approval + send) API.
 *
 * Sits next to the unified inbox routes but lives under a dedicated
 * `/api/v1/inbox/gmail` prefix so the existing channel-agnostic
 * `POST /inbox/conversations/:id/messages` endpoint keeps its current
 * stub semantics.  Future channels (WhatsApp, Meta, GMB) will mirror
 * this layout.
 *
 * All routes require auth + the `gmailIntegration` plan feature.
 */

import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  approveGmailDraft,
  createGmailDraft,
  listGmailApprovals,
  rejectGmailDraft,
} from "../../controllers/inbox/gmailOutboundController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("gmailIntegration"));

router.post(
  "/conversations/:conversationId/draft",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  createGmailDraft,
);

router.get(
  "/approvals",
  authorize("admin", "superadmin", "marketing"),
  listGmailApprovals,
);

router.post(
  "/approvals/:id/approve",
  authorize("admin", "superadmin"),
  validateMongoId(),
  approveGmailDraft,
);

router.post(
  "/approvals/:id/reject",
  authorize("admin", "superadmin"),
  validateMongoId(),
  rejectGmailDraft,
);

export default router;
