/**
 * inboxRoutes.js — Unified Inbox API routes.
 *
 * Route structure:
 *   /channels            — Channel account management (admin-only)
 *   /conversations       — Conversation listing, status, assignment
 *   /conversations/:id/* — Per-conversation actions (read, close, snooze, etc.)
 *   /conversations/:conversationId/messages — Thread messages
 *   /messages/:id        — Individual message retrieval
 *   /identities          — Contact identity management
 *   /summary             — Inbox summary / counters
 *
 * All routes require authentication (protect middleware).
 * Channel-specific routes are gated by plan features.
 */

import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import {
  validateMongoId,
  validatePagination,
} from "../../middlewares/requestValidators.js";
import {
  // Channel accounts
  listChannelAccounts,
  getChannelAccount,
  createChannelAccount,
  updateChannelAccount,
  deleteChannelAccount,
  // Conversations
  listConversations,
  getConversation,
  updateConversation,
  assignConversation,
  markRead,
  markUnread,
  closeConversation,
  reopenConversation,
  snoozeConversation,
  deleteConversation,
  getInboxSummary,
  // Messages
  listMessages,
  getMessage,
  sendMessage,
  // Contact identities
  listContactIdentities,
  linkIdentityToContact,
} from "../../controllers/inbox/inboxController.js";

const router = express.Router();

// All inbox routes require authentication
router.use(protect);

// Gate the entire inbox behind the emailInbox feature (baseline inbox access)
router.use(requirePlanFeature("emailInbox"));

// ═══════════════════════════════════════════════════════════
// Inbox Summary
// ═══════════════════════════════════════════════════════════

router.get("/summary", getInboxSummary);

// ═══════════════════════════════════════════════════════════
// Channel Accounts (admin-only for connect/disconnect)
// ═══════════════════════════════════════════════════════════

router.get("/channels", listChannelAccounts);
router.get("/channels/:id", validateMongoId(), getChannelAccount);
router.post(
  "/channels",
  authorize("admin", "superadmin"),
  createChannelAccount,
);
router.put(
  "/channels/:id",
  authorize("admin", "superadmin"),
  validateMongoId(),
  updateChannelAccount,
);
router.delete(
  "/channels/:id",
  authorize("admin", "superadmin"),
  validateMongoId(),
  deleteChannelAccount,
);

// ═══════════════════════════════════════════════════════════
// Conversations
// ═══════════════════════════════════════════════════════════

router.get("/conversations", validatePagination(), listConversations);
router.get(
  "/conversations/:id",
  validateMongoId(),
  getConversation,
);
router.put(
  "/conversations/:id",
  validateMongoId(),
  updateConversation,
);
router.patch(
  "/conversations/:id/assign",
  authorize("admin", "superadmin", "marketing"),
  validateMongoId(),
  assignConversation,
);
router.patch(
  "/conversations/:id/read",
  validateMongoId(),
  markRead,
);
router.patch(
  "/conversations/:id/unread",
  validateMongoId(),
  markUnread,
);
router.patch(
  "/conversations/:id/close",
  validateMongoId(),
  closeConversation,
);
router.patch(
  "/conversations/:id/reopen",
  validateMongoId(),
  reopenConversation,
);
router.patch(
  "/conversations/:id/snooze",
  validateMongoId(),
  snoozeConversation,
);
router.delete(
  "/conversations/:id",
  authorize("admin", "superadmin"),
  validateMongoId(),
  deleteConversation,
);

// ═══════════════════════════════════════════════════════════
// Messages (nested under conversations)
// ═══════════════════════════════════════════════════════════

router.get(
  "/conversations/:conversationId/messages",
  validateMongoId("conversationId"),
  validatePagination(),
  listMessages,
);
router.post(
  "/conversations/:conversationId/messages",
  validateMongoId("conversationId"),
  sendMessage,
);
router.get(
  "/messages/:id",
  validateMongoId(),
  getMessage,
);

// ═══════════════════════════════════════════════════════════
// Contact Identities
// ═══════════════════════════════════════════════════════════

router.get("/identities", listContactIdentities);
router.patch(
  "/identities/:id/link",
  validateMongoId(),
  linkIdentityToContact,
);

export default router;
