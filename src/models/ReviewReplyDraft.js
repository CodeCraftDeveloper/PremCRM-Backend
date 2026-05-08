import mongoose from "mongoose";

/**
 * ReviewReplyDraft - approval-gated Google Business Profile review reply.
 *
 * ApprovalRequest points at this model with type `gmb.reply` and
 * relatedEntityType `review_reply`; the future GMB publish worker consumes
 * approved drafts from this collection.
 */

export const REVIEW_REPLY_DRAFT_STATUSES = Object.freeze([
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "publishing",
  "published",
  "failed",
  "cancelled",
]);

export const REVIEW_REPLY_DRAFT_SOURCES = Object.freeze([
  "human",
  "ai",
  "workflow",
]);

const reviewReplyDraftSchema = new mongoose.Schema(
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

    gmbLocationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GmbLocation",
      required: true,
      index: true,
    },

    reviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Review",
      required: true,
      index: true,
    },

    body: {
      type: String,
      required: [true, "Review reply body is required"],
      trim: true,
      minlength: 1,
      maxlength: 4096,
    },

    source: {
      type: String,
      enum: REVIEW_REPLY_DRAFT_SOURCES,
      default: "human",
    },

    status: {
      type: String,
      enum: REVIEW_REPLY_DRAFT_STATUSES,
      default: "draft",
      index: true,
    },

    requiresApproval: { type: Boolean, default: true },

    aiGenerated: { type: Boolean, default: false },
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AIRun",
      default: null,
    },
    contentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContentDraft",
      default: null,
    },
    confidence: { type: Number, min: 0, max: 1, default: null },
    riskFlags: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },

    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovalRequest",
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    providerReplyId: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    providerUpdateTime: { type: Date, default: null },

    error: {
      message: { type: String, default: null, maxlength: 4000 },
      code: { type: String, default: null, maxlength: 128 },
      nonRetryable: { type: Boolean, default: false },
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

reviewReplyDraftSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
reviewReplyDraftSchema.index({ tenantId: 1, reviewId: 1, createdAt: -1 });
reviewReplyDraftSchema.index({
  tenantId: 1,
  gmbLocationId: 1,
  status: 1,
});
reviewReplyDraftSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "review_reply_draft_idempotency_uniq",
  },
);

reviewReplyDraftSchema.pre("validate", function preValidate() {
  if (this.source === "ai") {
    this.aiGenerated = true;
  }
  if (this.aiGenerated && !this.aiRunId) {
    this.invalidate("aiRunId", "AI-generated review replies require aiRunId");
  }
});

const ReviewReplyDraft = mongoose.model(
  "ReviewReplyDraft",
  reviewReplyDraftSchema,
);

export default ReviewReplyDraft;
