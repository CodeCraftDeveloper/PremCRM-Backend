import mongoose from "mongoose";

/**
 * Phase-1 strict whitelist — safe, flat field types only.
 * "reference" maps to a 1-level safe join against an existing module.
 * Legacy aliases (lookup, user_lookup) are kept for backward compat.
 */
export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "currency",
  "percent",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "boolean",
  "select",
  "multiselect",
  "reference",
  "lookup",
  "user_lookup",
  "auto_number",
];

/** Phase-1 strict whitelist (subset exposed to tenants). */
export const PHASE1_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multiselect",
  "currency",
  "reference",
];

/** Maximum custom fields allowed per module per tenant. */
export const MAX_FIELDS_PER_MODULE = 100;

/**
 * CustomField — Tenant-defined fields attached to any module (built-in or custom).
 *
 * Fields describe *metadata* only — actual data lives in the record's
 * `customData` Map or in a dynamic collection row.
 */
const customFieldSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Target module ───────────────────────────────────
    /** e.g. "leads", "contacts", "deals", or a custom module apiName */
    moduleApiName: {
      type: String,
      required: [true, "Module API name is required"],
      trim: true,
      lowercase: true,
    },

    // ── Field identity ──────────────────────────────────
    label: {
      type: String,
      required: [true, "Field label is required"],
      trim: true,
      maxlength: 120,
    },
    apiName: {
      type: String,
      required: [true, "Field API name is required"],
      trim: true,
      lowercase: true,
      match: [
        /^cf_[a-z][a-z0-9_]{0,46}$/,
        "apiName must start with cf_ followed by lowercase letters/numbers/underscores (max 49 chars)",
      ],
    },
    description: {
      type: String,
      maxlength: 500,
    },

    // ── Type & validation ───────────────────────────────
    fieldType: {
      type: String,
      required: [true, "Field type is required"],
      enum: {
        values: FIELD_TYPES,
        message: "Invalid field type: {VALUE}",
      },
    },
    isRequired: {
      type: Boolean,
      default: false,
    },
    isUnique: {
      type: Boolean,
      default: false,
    },
    defaultValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── Type-specific options ───────────────────────────
    /** For select / multiselect */
    options: [
      {
        label: { type: String, trim: true, maxlength: 120 },
        value: { type: String, trim: true, maxlength: 120 },
        color: { type: String, trim: true, maxlength: 20 },
      },
    ],
    /** For number / currency / percent */
    numberConfig: {
      min: { type: Number, default: null },
      max: { type: Number, default: null },
      precision: { type: Number, default: 2, min: 0, max: 8 },
      currencyCode: { type: String, default: "USD", maxlength: 5 },
    },
    /** For text / textarea */
    textConfig: {
      minLength: { type: Number, default: null },
      maxLength: { type: Number, default: null },
      pattern: { type: String, default: null, maxlength: 200 },
    },
    /** For lookup (reference another module) */
    lookupConfig: {
      targetModule: { type: String, trim: true },
      displayField: { type: String, default: "name", trim: true },
    },
    /** For auto_number */
    autoNumberConfig: {
      prefix: { type: String, default: "", maxlength: 10 },
      startFrom: { type: Number, default: 1 },
      currentValue: { type: Number, default: 0 },
    },
    /** For reference type — safe 1-level join to an existing module */
    referenceConfig: {
      targetModule: { type: String, trim: true },
      displayField: { type: String, default: "name", trim: true },
    },

    // ── Validation rules (JSON rule format) ──────────────
    validation: {
      /** Standard validators */
      min: { type: Number, default: null },
      max: { type: Number, default: null },
      regex: { type: String, default: null, maxlength: 200 },
      regexMessage: { type: String, default: null, maxlength: 200 },
      /**
       * Conditional required rules — array of JSON rules.
       * Each rule: { field: "cf_status", operator: "eq", value: "active" }
       * Operators: eq, neq, in, nin, exists, gt, lt, gte, lte
       * When ALL conditions match, this field becomes required.
       */
      conditionalRequired: [
        {
          field: { type: String, trim: true },
          operator: {
            type: String,
            enum: [
              "eq",
              "neq",
              "in",
              "nin",
              "exists",
              "gt",
              "lt",
              "gte",
              "lte",
            ],
          },
          value: { type: mongoose.Schema.Types.Mixed },
        },
      ],
    },

    // ── Role-based visibility ────────────────────────────
    /** If empty → visible to all roles. Otherwise only listed roles see this field. */
    visibleToRoles: [
      {
        type: String,
        enum: ["superadmin", "admin", "marketing", "user"],
      },
    ],

    // ── Display ─────────────────────────────────────────
    placeholder: { type: String, trim: true, maxlength: 200 },
    helpText: { type: String, trim: true, maxlength: 500 },
    sortOrder: { type: Number, default: 0 },
    isVisibleInList: { type: Boolean, default: true },
    isVisibleInDetail: { type: Boolean, default: true },
    isFilterable: { type: Boolean, default: false },
    isSearchable: { type: Boolean, default: false },
    /**
     * When true, this field's value is also written to a flat
     * `searchIndex` object on the parent record for efficient queries.
     */
    isIndexed: { type: Boolean, default: false },

    // ── System ──────────────────────────────────────────
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
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
customFieldSchema.index(
  { tenantId: 1, moduleApiName: 1, apiName: 1 },
  { unique: true },
);
customFieldSchema.index({ tenantId: 1, moduleApiName: 1, sortOrder: 1 });

const CustomField = mongoose.model("CustomField", customFieldSchema);

export default CustomField;
