import mongoose from "mongoose";

const websiteSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Website name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
      index: true,
    },
    domain: {
      type: String,
      required: [true, "Domain is required"],
      trim: true,
      lowercase: true,
    },
    apiKey: {
      type: String,
      required: [true, "API key is required"],
      unique: true,
      index: true,
      select: false, // Don't include in queries by default
    },
    apiKeyPrefix: {
      // First 8 chars of API key for reference (not secret)
      type: String,
      index: true,
    },
    description: {
      type: String,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    // Lead source category
    category: {
      type: String,
      enum: ["contact_form", "landing_page", "webinar", "partner", "other"],
      default: "contact_form",
      index: true,
    },
    // Configuration for duplicate detection
    duplicateSettings: {
      checkEmail: { type: Boolean, default: true },
      checkPhone: { type: Boolean, default: true },
      checkNameEmail: { type: Boolean, default: false },
    },
    // Rate limiting per website
    rateLimit: {
      requestsPerMinute: {
        type: Number,
        default: 60,
        min: 1,
        max: 10000,
      },
      requestsPerDay: {
        type: Number,
        default: 5000,
        min: 1,
      },
    },
    // Webhook for notifications
    webhookUrl: {
      type: String,
      trim: true,
    },
    webhookSecret: {
      type: String,
      select: false,
    },
    // Track leakage
    stats: {
      totalLeads: { type: Number, default: 0 },
      leadsThisMonth: { type: Number, default: 0 },
      duplicatesDetected: { type: Number, default: 0 },
      lastLeadAt: { type: Date, default: null },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    ipWhitelist: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound unique index: one domain per tenant
websiteSchema.index({ tenantId: 1, domain: 1 }, { unique: true });
websiteSchema.index({ tenantId: 1, isActive: 1 });

// Query helper to exclude API key by default
websiteSchema.query.publicData = function () {
  return this.select("-apiKey -webhookSecret");
};

export default mongoose.model("Website", websiteSchema);
