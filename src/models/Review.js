import mongoose from "mongoose";

/**
 * Review - Google Business Profile review synced for a tenant location.
 *
 * Reviews are provider-owned reputation objects. They can be linked to CRM
 * contacts when identity matching is available, and can own approval-gated
 * reply drafts through ReviewReplyDraft.
 */

export const REVIEW_PROVIDERS = Object.freeze(["gmb"]);

export const REVIEW_STAR_RATINGS = Object.freeze([
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
]);

export const REVIEW_SENTIMENTS = Object.freeze([
  "positive",
  "neutral",
  "negative",
  "unknown",
]);

export const REVIEW_STATUSES = Object.freeze([
  "new",
  "needs_reply",
  "reply_pending_approval",
  "replied",
  "ignored",
  "archived",
]);

const reviewerSchema = new mongoose.Schema(
  {
    displayName: { type: String, trim: true, maxlength: 256, default: null },
    profilePhotoUrl: {
      type: String,
      trim: true,
      maxlength: 1024,
      default: null,
    },
    providerReviewerId: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },
    isAnonymous: { type: Boolean, default: false },
  },
  { _id: false },
);

const providerReplySchema = new mongoose.Schema(
  {
    comment: { type: String, maxlength: 4096, default: null },
    updateTime: { type: Date, default: null },
  },
  { _id: false },
);

const reviewSchema = new mongoose.Schema(
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

    provider: {
      type: String,
      enum: REVIEW_PROVIDERS,
      default: "gmb",
    },

    providerReviewId: {
      type: String,
      required: [true, "Provider review id is required"],
      trim: true,
      maxlength: 256,
    },

    reviewer: { type: reviewerSchema, default: () => ({}) },

    contactIdentityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContactIdentity",
      default: null,
      index: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },

    starRating: {
      type: String,
      enum: REVIEW_STAR_RATINGS,
      required: true,
    },

    rating: { type: Number, min: 1, max: 5, required: true },

    comment: { type: String, maxlength: 8192, default: "" },
    originalComment: { type: String, maxlength: 8192, default: null },

    sentiment: {
      type: String,
      enum: REVIEW_SENTIMENTS,
      default: "unknown",
      index: true,
    },

    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: "new",
      index: true,
    },

    providerCreateTime: { type: Date, default: null, index: true },
    providerUpdateTime: { type: Date, default: null },

    providerReply: { type: providerReplySchema, default: () => ({}) },
    replyDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReviewReplyDraft",
      default: null,
    },
    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovalRequest",
      default: null,
    },
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AIRun",
      default: null,
    },

    workflowRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkflowRun",
      default: null,
    },

    providerMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  { timestamps: true, versionKey: false },
);

const STAR_TO_NUMBER = Object.freeze({
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
});

reviewSchema.index({ tenantId: 1, gmbLocationId: 1, status: 1 });
reviewSchema.index({ tenantId: 1, rating: 1, providerCreateTime: -1 });
reviewSchema.index({ tenantId: 1, sentiment: 1, providerCreateTime: -1 });
reviewSchema.index(
  { tenantId: 1, provider: 1, providerReviewId: 1 },
  { unique: true, name: "review_provider_uniq" },
);

reviewSchema.pre("validate", function preValidate() {
  if (this.starRating && STAR_TO_NUMBER[this.starRating]) {
    if (this.rating == null) {
      this.rating = STAR_TO_NUMBER[this.starRating];
    } else if (this.rating !== STAR_TO_NUMBER[this.starRating]) {
      this.invalidate(
        "rating",
        `rating ${this.rating} does not match starRating ${this.starRating}`,
      );
    }
  }
});

const Review = mongoose.model("Review", reviewSchema);

export default Review;
