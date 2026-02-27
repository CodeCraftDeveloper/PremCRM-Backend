import mongoose from "mongoose";

/**
 * CustomModule — Tenant-defined CRM modules beyond the standard five.
 * Examples: "Projects", "Tickets", "Invoices".
 *
 * Each custom module gets its own dynamic collection for data rows,
 * referenced via `collectionName`.
 */
const customModuleSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Identity ────────────────────────────────────────
    displayName: {
      type: String,
      required: [true, "Module display name is required"],
      trim: true,
      maxlength: 80,
    },
    apiName: {
      type: String,
      required: [true, "Module API name is required"],
      trim: true,
      lowercase: true,
      match: [
        /^[a-z][a-z0-9_]{1,48}$/,
        "apiName must start with a letter, contain only lowercase letters, numbers, underscores (2-49 chars)",
      ],
    },
    pluralLabel: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    singularLabel: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    description: {
      type: String,
      maxlength: 500,
    },

    // ── Visual ──────────────────────────────────────────
    icon: {
      type: String,
      default: "Layers",
      maxlength: 40,
    },
    color: {
      type: String,
      default: "blue",
      maxlength: 20,
    },

    // ── Behaviour flags ─────────────────────────────────
    /** Mongo collection that stores records for this module */
    collectionName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    /** Name field used as the record's display name */
    primaryField: {
      type: String,
      default: "name",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    /** System modules (leads, contacts, etc.) cannot be deleted */
    isSystem: {
      type: Boolean,
      default: false,
    },

    // ── Ownership / Audit ───────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Soft delete ─────────────────────────────────────
    deletedAt: { type: Date, default: null },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ── Indexes ───────────────────────────────────────────────
customModuleSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
customModuleSchema.index({ tenantId: 1, isActive: 1 });

const CustomModule = mongoose.model("CustomModule", customModuleSchema);

export default CustomModule;
