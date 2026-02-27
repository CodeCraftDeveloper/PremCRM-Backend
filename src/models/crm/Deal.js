import mongoose from "mongoose";

/**
 * CRM Deal (Opportunity) — Tracks a potential sale through pipeline stages.
 */
const stageHistoryEntry = new mongoose.Schema(
  {
    stage: { type: String, required: true },
    enteredAt: { type: Date, default: Date.now },
    exitedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
    movedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const dealSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Deal Info ───────────────────────────────────────
    name: {
      type: String,
      required: [true, "Deal name is required"],
      trim: true,
      maxlength: 200,
    },
    amount: { type: Number, default: 0, min: 0 },
    closingDate: { type: Date, default: null },

    // ── Pipeline & Stage ────────────────────────────────
    pipelineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Pipeline",
      required: true,
      index: true,
    },
    stage: {
      type: String,
      required: true,
    },
    probability: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ── Relationships ───────────────────────────────────
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
      index: true,
    },

    // ── Owner ───────────────────────────────────────────
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Classification ──────────────────────────────────
    source: {
      type: String,
      enum: [
        "website",
        "referral",
        "cold_call",
        "email_campaign",
        "social_media",
        "event",
        "partner",
        "lead_conversion",
        "import",
        "other",
      ],
      default: "other",
    },
    type: {
      type: String,
      enum: ["new_business", "existing_business", "renewal"],
      default: "new_business",
    },

    // ── Result ──────────────────────────────────────────
    lostReason: { type: String, trim: true, maxlength: 500 },
    wonAt: { type: Date, default: null },
    lostAt: { type: Date, default: null },

    // ── Conversion ──────────────────────────────────────
    convertedFromLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    // ── Stage History ───────────────────────────────────
    stageHistory: [stageHistoryEntry],

    // ── Description / Notes ─────────────────────────────
    description: { type: String, maxlength: 5000 },

    // ── Flexible ────────────────────────────────────────
    tags: [{ type: String, trim: true }],
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    customData: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    /** Flattened searchable custom field values for efficient queries */
    searchIndex: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Soft delete ─────────────────────────────────────
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
dealSchema.index({ tenantId: 1, createdAt: -1 });
dealSchema.index({ tenantId: 1, pipelineId: 1, stage: 1 });
dealSchema.index({ tenantId: 1, ownerId: 1 });
dealSchema.index({ tenantId: 1, contactId: 1 });
dealSchema.index({ tenantId: 1, accountId: 1 });
dealSchema.index({ tenantId: 1, closingDate: 1 });
dealSchema.index({ tenantId: 1, wonAt: 1 });
dealSchema.index({ tenantId: 1, lostAt: 1 });

export default mongoose.model("Deal", dealSchema);
