import mongoose from "mongoose";

/**
 * Conversation — a unified inbox thread.
 *
 * Groups Messages over a single channel between the tenant's team
 * and an external party (lead, contact, reviewer, etc.).
 *
 * Status lifecycle:
 *   open → active, needs attention
 *   snoozed → temporarily dismissed, auto-reopens on new inbound
 *   closed → resolved; reopens on new inbound message
 */

export const CONVERSATION_STATUSES = Object.freeze([
  "open",
  "snoozed",
  "closed",
]);

export const CONVERSATION_CHANNELS = Object.freeze([
  "gmail",
  "whatsapp",
  "meta",
  "gmb",
]);

const conversationSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    channelAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChannelAccount",
      required: true,
      index: true,
    },
    channel: {
      type: String,
      required: [true, "Channel is required"],
      enum: CONVERSATION_CHANNELS,
    },
    providerThreadId: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },
    contactIdentityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContactIdentity",
      default: null,
    },
    participantName: { type: String, trim: true, maxlength: 200, default: null },
    participantAvatar: { type: String, trim: true, maxlength: 1024, default: null },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "open",
    },
    assigneeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    priority: { type: Number, min: 1, max: 5, default: 3 },
    tags: { type: [String], default: [] },
    messageCount: { type: Number, default: 0, min: 0 },
    unreadCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
    lastMessageSnippet: { type: String, trim: true, maxlength: 300, default: null },
    lastMessageDirection: { type: String, enum: ["inbound", "outbound"], default: null },
    snoozedUntil: { type: Date, default: null },
    firstMessageAt: { type: Date, default: null },
    firstUnrepliedAt: { type: Date, default: null },
    firstReplyAt: { type: Date, default: null },
    dealId: { type: mongoose.Schema.Types.ObjectId, ref: "Deal", default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
conversationSchema.index({ tenantId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, assigneeId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, channel: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index(
  { tenantId: 1, channelAccountId: 1, providerThreadId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerThreadId: { $type: "string" } },
    name: "conversation_provider_thread_uniq",
  },
);
conversationSchema.index({ tenantId: 1, contactId: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, createdAt: -1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
