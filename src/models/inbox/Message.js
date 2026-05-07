import mongoose from "mongoose";

/**
 * Message — a single message within a Conversation.
 *
 * Represents one email, WhatsApp message, Meta DM, or GMB review
 * reply. Both inbound (from external party) and outbound (from
 * tenant team or AI) messages live here.
 *
 * Delivery lifecycle:
 *   pending   → queued for send (outbound only)
 *   sent      → provider accepted / inbound received
 *   delivered → provider confirmed delivery
 *   read      → recipient read (WhatsApp blue ticks, etc.)
 *   failed    → send failed permanently
 *   bounced   → email bounced
 */

export const MESSAGE_DIRECTIONS = Object.freeze(["inbound", "outbound"]);

export const MESSAGE_STATUSES = Object.freeze([
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
  "bounced",
]);

export const MESSAGE_CONTENT_TYPES = Object.freeze([
  "text",
  "html",
  "image",
  "video",
  "audio",
  "document",
  "location",
  "contact_card",
  "template",
  "interactive",
  "reaction",
  "system",
]);

const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, trim: true, maxlength: 512 },
    mimeType: { type: String, trim: true, maxlength: 128 },
    sizeBytes: { type: Number, min: 0, default: 0 },
    /** S3 key or pre-signed URL path. */
    storageKey: { type: String, trim: true, maxlength: 1024, default: null },
    /** Provider media ID for re-download. */
    providerMediaId: { type: String, trim: true, maxlength: 512, default: null },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    channelAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChannelAccount",
      required: true,
    },
    channel: {
      type: String,
      required: true,
      enum: ["gmail", "whatsapp", "meta", "gmb"],
    },

    // ── Direction & status ───────────────────────────────
    direction: {
      type: String,
      required: true,
      enum: MESSAGE_DIRECTIONS,
    },
    status: {
      type: String,
      enum: MESSAGE_STATUSES,
      default: "sent",
    },

    // ── Provider references ──────────────────────────────
    /** Provider-side unique message ID (for dedup and status updates). */
    providerMessageId: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },

    // ── Content ──────────────────────────────────────────
    contentType: {
      type: String,
      enum: MESSAGE_CONTENT_TYPES,
      default: "text",
    },
    /** Plain text body or text representation. */
    body: {
      type: String,
      maxlength: 64_000,
      default: "",
    },
    /** HTML body (email). */
    htmlBody: {
      type: String,
      maxlength: 256_000,
      default: null,
      select: false,
    },
    /** Email subject line (Gmail only). */
    subject: {
      type: String,
      trim: true,
      maxlength: 998,
      default: null,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },

    // ── Participants ─────────────────────────────────────
    /** Sender display (for outbound: team member; for inbound: external). */
    senderName: { type: String, trim: true, maxlength: 200, default: null },
    senderIdentifier: { type: String, trim: true, maxlength: 320, default: null },
    /** Contact identity that sent/received this message. */
    contactIdentityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContactIdentity",
      default: null,
    },
    /** Team user who sent this message (outbound only). */
    sentByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── AI / automation ──────────────────────────────────
    /** True if this message was drafted by AI. */
    aiGenerated: { type: Boolean, default: false },
    /** Linked AI run that produced the draft. */
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    /** Linked approval request (for outbound requiring human review). */
    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ── Metadata ─────────────────────────────────────────
    /** Provider-specific metadata (headers, template params, etc.). */
    providerMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // ── Timestamps ───────────────────────────────────────
    /** When the message was sent/received at the provider. */
    providerTimestamp: {
      type: Date,
      default: null,
    },
    /** When delivery was confirmed. */
    deliveredAt: { type: Date, default: null },
    /** When the recipient read the message. */
    readAt: { type: Date, default: null },
    /** When a send failure occurred. */
    failedAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, maxlength: 2000, default: null },

    // ── Soft delete ──────────────────────────────────────
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
// Primary inbox query: messages in a conversation, chronological.
messageSchema.index({ tenantId: 1, conversationId: 1, createdAt: 1 });

// Provider dedup: find message by provider ID within a channel account.
messageSchema.index(
  { tenantId: 1, channelAccountId: 1, providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerMessageId: { $type: "string" } },
    name: "message_provider_id_uniq",
  },
);

// Status update lookup (e.g. WhatsApp delivery receipts).
messageSchema.index({ channelAccountId: 1, providerMessageId: 1 });

messageSchema.index({ tenantId: 1, createdAt: -1 });

// 180-day TTL on soft-deleted messages.
messageSchema.index(
  { deletedAt: 1 },
  {
    expireAfterSeconds: 180 * 24 * 60 * 60,
    partialFilterExpression: { deletedAt: { $type: "date" } },
  },
);

const Message = mongoose.model("Message", messageSchema);

export default Message;
