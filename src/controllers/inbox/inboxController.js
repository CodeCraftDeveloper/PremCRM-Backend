/**
 * inboxController.js — Unified Inbox API controllers.
 *
 * All handlers are tenant-scoped via req.user.tenantId set by the
 * `protect` middleware.  Plan-feature gates are applied at the route level.
 */

import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { InboxService } from "../../services/inboxService.js";

// ═══════════════════════════════════════════════════════════
// Channel Accounts
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/v1/inbox/channels
 * @desc    List channel accounts for the tenant
 */
export const listChannelAccounts = asyncHandler(async (req, res, next) => {
  try {
    const { provider, status } = req.query;
    const accounts = await InboxService.listChannelAccounts(
      req.user.tenantId,
      { provider, status },
    );
    successResponse(res, accounts, "Channel accounts retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/inbox/channels/:id
 * @desc    Get a single channel account
 */
export const getChannelAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await InboxService.getChannelAccount(
      req.user.tenantId,
      req.params.id,
    );
    if (!account) return next(ApiError.notFound("Channel account not found"));
    successResponse(res, account, "Channel account retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/inbox/channels
 * @desc    Connect a new channel account
 */
export const createChannelAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await InboxService.createChannelAccount(
      req.user.tenantId,
      req.body,
      req.user._id,
    );
    successResponse(res, account, "Channel account connected", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/inbox/channels/:id
 * @desc    Update a channel account
 */
export const updateChannelAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await InboxService.updateChannelAccount(
      req.user.tenantId,
      req.params.id,
      req.body,
    );
    if (!account) return next(ApiError.notFound("Channel account not found"));
    successResponse(res, account, "Channel account updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/inbox/channels/:id
 * @desc    Disconnect (soft-delete) a channel account
 */
export const deleteChannelAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await InboxService.deleteChannelAccount(
      req.user.tenantId,
      req.params.id,
      req.user._id,
    );
    if (!account) return next(ApiError.notFound("Channel account not found"));
    successResponse(res, null, "Channel account disconnected");
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════
// Conversations
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/v1/inbox/conversations
 * @desc    List conversations with filtering + pagination
 */
export const listConversations = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, status, channel, assigneeId, contactId, search } =
      req.query;

    // Parse structured sort from query
    const sort = req.query["sort[field]"]
      ? { field: req.query["sort[field]"], direction: req.query["sort[direction]"] || "desc" }
      : undefined;

    const result = await InboxService.listConversations(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      channel,
      assigneeId,
      contactId,
      search,
      sort,
    });
    paginatedResponse(
      res,
      result.conversations,
      result.pagination,
      "Conversations retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/inbox/conversations/:id
 * @desc    Get a single conversation
 */
export const getConversation = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.getConversation(
      req.user.tenantId,
      req.params.id,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/inbox/conversations/:id
 * @desc    Update conversation (status, priority, tags, CRM links)
 */
export const updateConversation = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.updateConversation(
      req.user.tenantId,
      req.params.id,
      req.body,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/assign
 * @desc    Assign conversation to a team member
 */
export const assignConversation = asyncHandler(async (req, res, next) => {
  try {
    const { assigneeId } = req.body;
    if (!assigneeId) return next(ApiError.badRequest("assigneeId is required"));
    const conversation = await InboxService.assignConversation(
      req.user.tenantId,
      req.params.id,
      assigneeId,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation assigned");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/read
 * @desc    Mark conversation as read
 */
export const markRead = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.markConversationRead(
      req.user.tenantId,
      req.params.id,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation marked as read");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/unread
 * @desc    Mark conversation as unread
 */
export const markUnread = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.markConversationUnread(
      req.user.tenantId,
      req.params.id,
    );
    // If conversation was already unread, no doc is returned by the condition match
    if (!conversation) {
      // Still fetch to check existence vs already-unread
      const existing = await InboxService.getConversation(
        req.user.tenantId,
        req.params.id,
      );
      if (!existing) return next(ApiError.notFound("Conversation not found"));
      return successResponse(res, existing, "Conversation already unread");
    }
    successResponse(res, conversation, "Conversation marked as unread");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/close
 * @desc    Close a conversation
 */
export const closeConversation = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.closeConversation(
      req.user.tenantId,
      req.params.id,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation closed");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/reopen
 * @desc    Reopen a conversation
 */
export const reopenConversation = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.reopenConversation(
      req.user.tenantId,
      req.params.id,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation reopened");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/conversations/:id/snooze
 * @desc    Snooze a conversation until a specified date
 */
export const snoozeConversation = asyncHandler(async (req, res, next) => {
  try {
    const { until } = req.body;
    if (!until) return next(ApiError.badRequest("until (ISO date) is required"));
    const snoozedUntil = new Date(until);
    if (isNaN(snoozedUntil.getTime())) {
      return next(ApiError.badRequest("until must be a valid ISO date"));
    }
    if (snoozedUntil <= new Date()) {
      return next(ApiError.badRequest("until must be in the future"));
    }
    const conversation = await InboxService.snoozeConversation(
      req.user.tenantId,
      req.params.id,
      snoozedUntil,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, conversation, "Conversation snoozed");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/inbox/conversations/:id
 * @desc    Soft-delete a conversation
 */
export const deleteConversation = asyncHandler(async (req, res, next) => {
  try {
    const conversation = await InboxService.deleteConversation(
      req.user.tenantId,
      req.params.id,
      req.user._id,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));
    successResponse(res, null, "Conversation deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/inbox/summary
 * @desc    Get inbox summary (counts by status, channel, total unread)
 */
export const getInboxSummary = asyncHandler(async (req, res, next) => {
  try {
    const summary = await InboxService.getInboxSummary(req.user.tenantId);
    successResponse(res, summary, "Inbox summary retrieved");
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/v1/inbox/conversations/:conversationId/messages
 * @desc    List messages for a conversation
 */
export const listMessages = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit } = req.query;

    // Validate conversation belongs to tenant
    const conversation = await InboxService.getConversation(
      req.user.tenantId,
      req.params.conversationId,
    );
    if (!conversation) return next(ApiError.notFound("Conversation not found"));

    const result = await InboxService.listMessages(
      req.user.tenantId,
      req.params.conversationId,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 50 },
    );
    paginatedResponse(
      res,
      result.messages,
      result.pagination,
      "Messages retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/inbox/messages/:id
 * @desc    Get a single message
 */
export const getMessage = asyncHandler(async (req, res, next) => {
  try {
    const message = await InboxService.getMessage(
      req.user.tenantId,
      req.params.id,
    );
    if (!message) return next(ApiError.notFound("Message not found"));
    successResponse(res, message, "Message retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/inbox/conversations/:conversationId/messages
 * @desc    Send/queue an outbound message
 */
export const sendMessage = asyncHandler(async (req, res, next) => {
  try {
    const message = await InboxService.createOutboundMessage(
      req.user.tenantId,
      req.params.conversationId,
      req.body,
      req.user._id,
    );
    successResponse(res, message, "Message sent", 201);
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════
// Contact Identities
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/v1/inbox/identities
 * @desc    List contact identities
 */
export const listContactIdentities = asyncHandler(async (req, res, next) => {
  try {
    const { contactId, provider } = req.query;
    const identities = await InboxService.listContactIdentities(
      req.user.tenantId,
      { contactId, provider },
    );
    successResponse(res, identities, "Contact identities retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/inbox/identities/:id/link
 * @desc    Link identity to a CRM contact
 */
export const linkIdentityToContact = asyncHandler(async (req, res, next) => {
  try {
    const { contactId } = req.body;
    if (!contactId) return next(ApiError.badRequest("contactId is required"));
    const identity = await InboxService.linkIdentityToContact(
      req.user.tenantId,
      req.params.id,
      contactId,
    );
    if (!identity) return next(ApiError.notFound("Contact identity not found"));
    successResponse(res, identity, "Identity linked to contact");
  } catch (error) {
    next(error);
  }
});
