import mongoose from "mongoose";

const socialPostSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    contentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContentDraft",
      required: true,
      index: true,
    },
    variantId: {
      type: String,
      required: true,
      trim: true,
    },
    channel: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      maxlength: 32000,
    },
    mediaUrl: {
      type: String,
      trim: true,
      maxlength: 1024,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "success",
    },
    publishedAt: {
      type: Date,
      default: Date.now,
    },
    isAd: {
      type: Boolean,
      default: false,
    },
    adConfig: {
      budget: { type: Number, default: 0 },
      durationDays: { type: Number, default: 0 },
      targetAudience: { type: String, trim: true, default: "" },
      status: { type: String, enum: ["active", "paused", "completed", "pending"], default: "pending" },
    },
    metrics: {
      impressions: { type: Number, default: 0 },
      reach: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      conversions: { type: Number, default: 0 },
      spend: { type: Number, default: 0 },
    },
    externalPostId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true, versionKey: false }
);

socialPostSchema.index({ tenantId: 1, createdAt: -1 });
socialPostSchema.index({ tenantId: 1, isAd: 1 });

const SocialPost = mongoose.model("SocialPost", socialPostSchema);
export default SocialPost;
