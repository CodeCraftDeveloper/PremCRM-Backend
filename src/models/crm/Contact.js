import mongoose from "mongoose";

/**
 * CRM Contact — Represents a person.
 * Contacts may belong to an Account (company).
 * Can be created directly or via lead conversion.
 */
const contactSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Personal Info ───────────────────────────────────
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: 80,
    },
    lastName: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    fullName: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },
    phone: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },
    mobile: { type: String, trim: true },

    // ── Professional Info ───────────────────────────────
    title: { type: String, trim: true, maxlength: 120 },
    department: { type: String, trim: true, maxlength: 120 },

    // ── Account Link ────────────────────────────────────
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

    // ── Source ───────────────────────────────────────────
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

    // ── Address ─────────────────────────────────────────
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
      zipCode: { type: String, trim: true },
    },

    // ── Social ──────────────────────────────────────────
    social: {
      linkedin: { type: String, trim: true },
      twitter: { type: String, trim: true },
      facebook: { type: String, trim: true },
    },

    // ── Description / Notes ─────────────────────────────
    description: {
      type: String,
      maxlength: 5000,
    },

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
contactSchema.index({ tenantId: 1, createdAt: -1 });
contactSchema.index({ tenantId: 1, email: 1 });
contactSchema.index({ tenantId: 1, phone: 1 });
contactSchema.index({ tenantId: 1, accountId: 1 });
contactSchema.index({ tenantId: 1, ownerId: 1 });
contactSchema.index({ tenantId: 1, source: 1 });
contactSchema.index(
  { tenantId: 1, fullName: "text", email: "text" },
  { name: "contact_text_search" },
);

// ── Pre-save: compute fullName ───────────────────────────
contactSchema.pre("save", function () {
  if (this.isModified("firstName") || this.isModified("lastName")) {
    this.fullName = [this.firstName, this.lastName].filter(Boolean).join(" ");
  }
});

export default mongoose.model("Contact", contactSchema);
