import mongoose from "mongoose";

/**
 * FormDefinition — Embeddable / public forms for a CRM module.
 *
 * Use-cases:
 *  - Public lead capture form (embedded on website)
 *  - Internal quick-add form (modal)
 *  - External survey / feedback form
 *
 * The `fieldMappings` array maps form field labels to module field apiNames.
 */
const fieldMappingSchema = new mongoose.Schema(
  {
    /** What the user sees on the form */
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    /** Which field (built-in or cf_*) the value maps to */
    fieldApiName: {
      type: String,
      required: true,
      trim: true,
    },
    /** Override field type for this form context (e.g. show textarea instead of text) */
    overrideType: {
      type: String,
      default: null,
    },
    isRequired: {
      type: Boolean,
      default: false,
    },
    placeholder: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    helpText: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    sortOrder: { type: Number, default: 0 },
    /** Hide from form but still submit a hardcoded/default value */
    isHidden: { type: Boolean, default: false },
    defaultValue: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const formDefinitionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Identity ────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Form name is required"],
      trim: true,
      maxlength: 120,
    },
    apiName: {
      type: String,
      required: [true, "Form API name is required"],
      trim: true,
      lowercase: true,
      match: [
        /^[a-z][a-z0-9_]{1,48}$/,
        "apiName must start with a letter, contain only lowercase letters, numbers, underscores",
      ],
    },
    description: {
      type: String,
      maxlength: 500,
    },

    // ── Target module ───────────────────────────────────
    moduleApiName: {
      type: String,
      required: [true, "Module API name is required"],
      trim: true,
      lowercase: true,
    },

    // ── Form type ───────────────────────────────────────
    /** "public" | "internal" | "embedded" */
    formType: {
      type: String,
      enum: ["public", "internal", "embedded"],
      default: "internal",
    },

    // ── Field mappings (ordered) ────────────────────────
    fieldMappings: [fieldMappingSchema],

    // ── Display settings ────────────────────────────────
    settings: {
      submitLabel: { type: String, default: "Submit", maxlength: 60 },
      successMessage: {
        type: String,
        default: "Thank you! Your submission has been received.",
        maxlength: 500,
      },
      redirectUrl: { type: String, default: null, maxlength: 500 },
      /** Auto-assign new records to this user */
      defaultOwnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      /** css class / theme token */
      theme: { type: String, default: "default", maxlength: 40 },
      /** reCAPTCHA, honeypot, etc. */
      captchaEnabled: { type: Boolean, default: false },
      /** Notify these user IDs on submission */
      notifyUsers: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
    },

    // ── Stats ───────────────────────────────────────────
    submissionCount: { type: Number, default: 0 },
    lastSubmissionAt: { type: Date, default: null },

    // ── System ──────────────────────────────────────────
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
formDefinitionSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
formDefinitionSchema.index({ tenantId: 1, moduleApiName: 1 });
formDefinitionSchema.index({ tenantId: 1, formType: 1, isActive: 1 });

const FormDefinition = mongoose.model("FormDefinition", formDefinitionSchema);

export default FormDefinition;
