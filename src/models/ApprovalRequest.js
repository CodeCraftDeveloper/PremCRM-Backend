import mongoose from "mongoose";

/**
 * ApprovalRequest — human approval gate for outbound automated/AI actions.
 *
 * Per ADR-004 every AI-driven outbound action (Gmail send, WhatsApp reply,
 * GMB review reply, social publish, etc.) must pass through an explicit
 * approval before the provider call fires.  Human-composed actions can
 * also flow through this model with status `auto_approved` so the audit
 * trail and downstream queueing logic stay uniform.
 *
 * Lifecycle:
 *   pending       → awaiting human decision (default for AI drafts)
 *   approved      → human approved; downstream processor may execute
 *   auto_approved → human-composed and immediately approved
 *   rejected      → human rejected; no execution; related entity is failed
 *   expired       → TTL elapsed before a decision was made
 */

export const APPROVAL_REQUEST_TYPES = Object.freeze([
  "gmail.send",
  "whatsapp.send",
  "meta.publish",
  "gmb.reply",
  "ai.action",
]);

export const APPROVAL_REQUEST_STATUSES = Object.freeze([
  "pending",
  "approved",
  "auto_approved",
  "rejected",
  "expired",
]);

export const APPROVAL_RELATED_ENTITY_TYPES = Object.freeze([
  "message",
  "review_reply",
  "social_post",
  "ai_run",
]);

const approvalRequestSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    /** What kind of action is awaiting approval. */
    type: {
      type: String,
      required: true,
      enum: APPROVAL_REQUEST_TYPES,
    },

    status: {
      type: String,
      enum: APPROVAL_REQUEST_STATUSES,
      default: "pending",
    },

    /**
     * Polymorphic link to the entity awaiting execution.
     * Currently `message` for outbound Gmail/WhatsApp drafts.
     */
    relatedEntityType: {
      type: String,
      enum: APPROVAL_RELATED_ENTITY_TYPES,
      required: true,
    },
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    /**
     * Optional snapshot of the action payload — useful for review UI when
     * the related entity is mutated after approval.  Sensitive content
     * (full HTML body, API payloads) lives on the related entity, not here.
     */
    summary: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    /** AI provenance — null when the draft is human-composed. */
    aiGenerated: { type: Boolean, default: false },
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    /** Confidence reported by the agent that produced the draft. */
    confidence: { type: Number, min: 0, max: 1, default: null },

    /** Who created the request. */
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /** Who decided. */
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: { type: Date, default: null },
    decisionReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    /**
     * Auto-expiry. Pending requests older than `expiresAt` are swept by a
     * future scheduler (Phase 7 approval queue tooling).  Hard TTL on
     * `expiresAt` keeps the collection bounded for the rare case the
     * sweeper falls behind.
     */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true, versionKey: false },
);

approvalRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
approvalRequestSchema.index({ tenantId: 1, type: 1, status: 1 });
approvalRequestSchema.index({
  tenantId: 1,
  relatedEntityType: 1,
  relatedEntityId: 1,
});

approvalRequestSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { status: "expired" },
  },
);

const ApprovalRequest = mongoose.model(
  "ApprovalRequest",
  approvalRequestSchema,
);

export default ApprovalRequest;
