import mongoose from "mongoose";

/**
 * CRM Account — Represents a company / organization.
 * Contacts and Deals link back to an Account.
 */
const accountSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Company Info ────────────────────────────────────
    name: {
      type: String,
      required: [true, "Account name is required"],
      trim: true,
      maxlength: 200,
    },
    industry: { type: String, trim: true, maxlength: 120 },
    website: { type: String, trim: true, maxlength: 300 },
    phone: { type: String, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    // ── Financials ──────────────────────────────────────
    annualRevenue: { type: Number, default: 0, min: 0 },
    numberOfEmployees: { type: Number, default: 0, min: 0 },

    // ── Type ────────────────────────────────────────────
    type: {
      type: String,
      enum: [
        "prospect",
        "customer",
        "partner",
        "vendor",
        "competitor",
        "other",
      ],
      default: "prospect",
    },

    // ── Owner ───────────────────────────────────────────
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Addresses ───────────────────────────────────────
    billingAddress: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
      zipCode: { type: String, trim: true },
    },
    shippingAddress: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      zipCode: { type: String, trim: true },
    },

    // ── Hierarchy ───────────────────────────────────────
    parentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },

    // ── Description / Notes ─────────────────────────────
    description: { type: String, maxlength: 5000 },

    // ── Conversion ──────────────────────────────────────
    convertedFromLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

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
accountSchema.index({ tenantId: 1, createdAt: -1 });
accountSchema.index({ tenantId: 1, name: 1 });
accountSchema.index({ tenantId: 1, ownerId: 1 });
accountSchema.index({ tenantId: 1, industry: 1 });
accountSchema.index({ tenantId: 1, type: 1 });
accountSchema.index(
  { tenantId: 1, name: "text", email: "text" },
  { name: "account_text_search" },
);

export default mongoose.model("Account", accountSchema);
