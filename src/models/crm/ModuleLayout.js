import mongoose from "mongoose";

/**
 * ModuleLayout — Controls how fields are arranged in detail / edit views.
 *
 * One layout per module per tenant.  Sections → Columns → Fields.
 *
 * Example structure for `sections`:
 * [
 *   {
 *     title: "Basic Info",
 *     columns: 2,
 *     fields: ["fullName", "email", "cf_student_id"]
 *   },
 *   {
 *     title: "Additional",
 *     columns: 1,
 *     collapsed: true,
 *     fields: ["description", "cf_remarks"]
 *   }
 * ]
 */
const sectionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    columns: {
      type: Number,
      default: 2,
      min: 1,
      max: 4,
    },
    collapsed: {
      type: Boolean,
      default: false,
    },
    /** Ordered list of field apiNames (built-in or cf_*) */
    fields: [{ type: String, trim: true }],
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const moduleLayoutSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Target module ───────────────────────────────────
    moduleApiName: {
      type: String,
      required: [true, "Module API name is required"],
      trim: true,
      lowercase: true,
    },

    // ── Layout type ─────────────────────────────────────
    /** "detail" | "edit" | "create" | "list" | "kanban" */
    layoutType: {
      type: String,
      required: true,
      enum: ["detail", "edit", "create", "list", "kanban"],
      default: "detail",
    },

    // ── Sections ────────────────────────────────────────
    sections: [sectionSchema],

    // ── List view column order ──────────────────────────
    /** Only used when layoutType = "list" */
    listColumns: [
      {
        fieldApiName: { type: String, trim: true },
        width: { type: Number, default: null },
        sortable: { type: Boolean, default: true },
      },
    ],

    // ── Ownership ───────────────────────────────────────
    isDefault: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ── Indexes ───────────────────────────────────────────────
moduleLayoutSchema.index(
  { tenantId: 1, moduleApiName: 1, layoutType: 1 },
  { unique: true },
);

const ModuleLayout = mongoose.model("ModuleLayout", moduleLayoutSchema);

export default ModuleLayout;
