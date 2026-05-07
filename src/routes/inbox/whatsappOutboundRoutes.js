/**
 * WhatsApp outbound (draft + approval + send) API.
 */

import express from "express";
import { authorize, protect } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  approveWhatsappDraft,
  createWhatsappDraft,
  listWhatsappApprovals,
  rejectWhatsappDraft,
} from "../../controllers/inbox/whatsappOutboundController.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("whatsappIntegration"));

router.post(
  "/conversations/:conversationId/draft",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId("conversationId"),
  createWhatsappDraft,
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

export default router;
