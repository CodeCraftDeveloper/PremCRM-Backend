import mongoose from "mongoose";

const socialTrendSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    sentiment: {
      type: String,
      trim: true,
      maxlength: 64,
      default: "neutral", // positive, negative, neutral
    },
    volume: {
      type: String,
      trim: true,
      maxlength: 64,
      default: "N/A", // e.g. "120K searches", "High Engagement"
    },
    relevanceScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
    },
    source: {
      type: String,
      trim: true,
      maxlength: 128,
      default: "AI Trend Discovery",
    },
  },
  { timestamps: true, versionKey: false }
);

socialTrendSchema.index({ tenantId: 1, createdAt: -1 });

const SocialTrend = mongoose.model("SocialTrend", socialTrendSchema);
export default SocialTrend;
