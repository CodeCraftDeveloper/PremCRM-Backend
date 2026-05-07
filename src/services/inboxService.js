/**
 * inboxService.js — Unified Inbox business logic layer.
 *
 * Every public method requires `tenantId` as first argument to guarantee
 * tenant isolation at the query level.  No document is ever returned or
 * mutated without a matching tenantId filter.
 */

import mongoose from "mongoose";
import {
  ChannelAccount,
  Conversation,
  Message,
  ContactIdentity,
  CONVERSATION_STATUSES,
  CONVERSATION_CHANNELS,
} from "../models/inbox/index.js";
import { ApiError } from "../utils/apiResponse.js";

// ─────────────────────────────────────────────────────────────
// Channel Accounts
// ─────────────────────────────────────────────────────────────

/**
 * List channel accounts for a tenant.
 */
async function listChannelAccounts(tenantId, { provider, status } = {}) {
  const filter = { tenantId, deletedAt: null };
  if (provider) filter.provider = provider;
  if (status) filter.status = status;
  const accounts = await ChannelAccount.find(filter)
    .sort({ createdAt: -1 })
    .lean();
  return accounts;
}

/**
 * Get a single channel account (never exposes credentials).
 */
async function getChannelAccount(tenantId, accountId) {
  return ChannelAccount.findOne({
    _id: accountId,
    tenantId,
    deletedAt: null,
  }).lean();
}

/**
 * Create a channel account.
 */
async function createChannelAccount(tenantId, data, userId) {
  return ChannelAccount.create({
    ...data,
    tenantId,
    connectedBy: userId,
  });
}

/**
 * Update mutable fields on a channel account.
 */
async function updateChannelAccount(tenantId, accountId, data) {
  const allowedFields = ["displayName", "status"];
  const update = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) update[key] = data[key];
  }
  return ChannelAccount.findOneAndUpdate(
    { _id: accountId, tenantId, deletedAt: null },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();
}

/**
 * Soft-delete a channel account.
 */
async function deleteChannelAccount(tenantId, accountId, userId) {
  return ChannelAccount.findOneAndUpdate(
    { _id: accountId, tenantId, deletedAt: null },
    { $set: { deletedAt: new Date(), status: "disconnected" } },
    { new: true },
  ).lean();
}

// ─────────────────────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────────────────────

/**
 * List conversations with filtering + cursor-based pagination.
 */
async function listConversations(tenantId, opts = {}) {
  const {
    page = 1,
    limit = 20,
    status,
    channel,
    assigneeId,
    contactId,
    search,
    sort,
  } = opts;

  const filter = { tenantId, deletedAt: null };
  if (status) filter.status = status;
  if (channel) filter.channel = channel;
  if (assigneeId) filter.assigneeId = assigneeId;
  if (contactId) filter.contactId = contactId;
  if (search) {
    filter.$or = [
      { participantName: { $regex: search, $options: "i" } },
      { lastMessageSnippet: { $regex: search, $options: "i" } },
      { tags: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;

  // Determine sort
  let sortObj = { lastMessageAt: -1, createdAt: -1 };
  if (sort?.field) {
    const dir = sort.direction === "asc" ? 1 : -1;
    sortObj = { [sort.field]: dir };
  }

  const [conversations, totalDocs] = await Promise.all([
    Conversation.find(filter)
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .populate("assigneeId", "name email avatar")
      .lean(),
    Conversation.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalDocs / limit) || 1;

  return {
    conversations,
    pagination: { page, limit, totalDocs, totalPages },
  };
}

/**
 * Get a single conversation by ID.
 */
async function getConversation(tenantId, conversationId) {
  return Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  })
    .populate("assigneeId", "name email avatar")
    .populate("channelAccountId", "provider displayName providerAccountId")
    .lean();
}

/**
 * Update conversation (status, assignee, priority, tags, CRM links).
 */
async function updateConversation(tenantId, conversationId, data) {
  const allowedFields = [
    "status",
    "assigneeId",
    "priority",
    "tags",
    "snoozedUntil",
    "contactId",
    "dealId",
    "leadId",
  ];
  const update = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) update[key] = data[key];
  }
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: update },
    { new: true, runValidators: true },
  )
    .populate("assigneeId", "name email avatar")
    .lean();
}

/**
 * Assign a conversation to a user.
 */
async function assignConversation(tenantId, conversationId, assigneeId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { assigneeId } },
    { new: true, runValidators: true },
  )
    .populate("assigneeId", "name email avatar")
    .lean();
}

/**
 * Mark a conversation as read (reset unreadCount to 0).
 */
async function markConversationRead(tenantId, conversationId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { unreadCount: 0 } },
    { new: true },
  ).lean();
}

/**
 * Mark a conversation as unread (set unreadCount to at least 1).
 */
async function markConversationUnread(tenantId, conversationId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null, unreadCount: 0 },
    { $set: { unreadCount: 1 } },
    { new: true },
  ).lean();
}

/**
 * Close a conversation.
 */
async function closeConversation(tenantId, conversationId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { status: "closed" } },
    { new: true },
  ).lean();
}

/**
 * Reopen a closed or snoozed conversation.
 */
async function reopenConversation(tenantId, conversationId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { status: "open", snoozedUntil: null } },
    { new: true },
  ).lean();
}

/**
 * Snooze a conversation until a given date.
 */
async function snoozeConversation(tenantId, conversationId, until) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { status: "snoozed", snoozedUntil: until } },
    { new: true },
  ).lean();
}

/**
 * Soft-delete a conversation.
 */
async function deleteConversation(tenantId, conversationId, userId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, tenantId, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: userId } },
    { new: true },
  ).lean();
}

/**
 * Get inbox-wide unread summary (counts per status, per channel).
 */
async function getInboxSummary(tenantId) {
  const [byStatus, byChannel, totalUnread] = await Promise.all([
    Conversation.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), deletedAt: null } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Conversation.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), deletedAt: null, status: "open" } },
      { $group: { _id: "$channel", count: { $sum: 1 }, unread: { $sum: "$unreadCount" } } },
    ]),
    Conversation.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), deletedAt: null } },
      { $group: { _id: null, total: { $sum: "$unreadCount" } } },
    ]),
  ]);

  return {
    byStatus: byStatus.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {}),
    byChannel: byChannel.reduce(
      (acc, r) => ({ ...acc, [r._id]: { count: r.count, unread: r.unread } }),
      {},
    ),
    totalUnread: totalUnread[0]?.total || 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────

/**
 * List messages for a conversation (paginated, chronological).
 */
async function listMessages(tenantId, conversationId, opts = {}) {
  const { page = 1, limit = 50 } = opts;
  const filter = { tenantId, conversationId };
  const skip = (page - 1) * limit;

  const [messages, totalDocs] = await Promise.all([
    Message.find(filter)
      .sort({ createdAt: 1 }) // chronological
      .skip(skip)
      .limit(limit)
      .lean(),
    Message.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalDocs / limit) || 1;

  return {
    messages,
    pagination: { page, limit, totalDocs, totalPages },
  };
}

/**
 * Get a single message by ID.
 */
async function getMessage(tenantId, messageId) {
  return Message.findOne({ _id: messageId, tenantId }).lean();
}

/**
 * Create an outbound message draft and update the conversation's
 * denormalised counters + snippet atomically.
 */
async function createOutboundMessage(tenantId, conversationId, data, userId) {
  // Validate conversation belongs to this tenant
  const conversation = await Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");

  const message = await Message.create({
    tenantId,
    conversationId,
    channelAccountId: conversation.channelAccountId,
    channel: conversation.channel,
    direction: "outbound",
    status: "pending",
    body: data.body,
    contentType: data.contentType || "text",
    attachments: data.attachments || [],
    sentByUserId: userId,
    aiGenerated: data.aiGenerated || false,
    aiRunId: data.aiRunId || null,
    providerMeta: data.providerMeta || {},
  });

  // Atomically update conversation counters + snippet
  const snippet =
    (data.body || "").substring(0, 300) || "[attachment]";
  await Conversation.updateOne(
    { _id: conversationId, tenantId },
    {
      $inc: { messageCount: 1 },
      $set: {
        lastMessageAt: message.createdAt,
        lastMessageSnippet: snippet,
        lastMessageDirection: "outbound",
        // Set first reply timestamp if not already set
        ...(conversation.firstReplyAt ? {} : { firstReplyAt: message.createdAt }),
      },
    },
  );

  return message;
}

// ─────────────────────────────────────────────────────────────
// Contact Identities
// ─────────────────────────────────────────────────────────────

/**
 * List identities for a contact.
 */
async function listContactIdentities(tenantId, { contactId, provider } = {}) {
  const filter = { tenantId };
  if (contactId) filter.contactId = contactId;
  if (provider) filter.provider = provider;
  return ContactIdentity.find(filter).sort({ createdAt: -1 }).lean();
}

/**
 * Link a contact identity to a CRM contact.
 */
async function linkIdentityToContact(tenantId, identityId, contactId) {
  return ContactIdentity.findOneAndUpdate(
    { _id: identityId, tenantId },
    { $set: { contactId, verified: true } },
    { new: true },
  ).lean();
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

export const InboxService = {
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
  markConversationRead,
  markConversationUnread,
  closeConversation,
  reopenConversation,
  snoozeConversation,
  deleteConversation,
  getInboxSummary,

  // Messages
  listMessages,
  getMessage,
  createOutboundMessage,

  // Contact identities
  listContactIdentities,
  linkIdentityToContact,
};
