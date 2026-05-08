import mongoose from "mongoose";

/**
 * WhatsappTemplate — tenant-scoped registry of approved Meta WhatsApp
 * Business templates. Mirrors the metadata Meta returns on the Business
 * Account graph so we can validate and render template messages before
 * sending them through the Cloud API.
 *
 * A template is keyed by (tenantId, name, language). Multiple language
 * variants of the same `name` are allowed; only `status === "approved"`
 * variants are eligible for sending.
 *
 * Components capture Meta's structured layout: HEADER (text/image/...),
 * BODY (text + named/positional parameters), FOOTER (text), BUTTONS
 * (URL/quick-reply/copy-code). Parameter rendering and validation use
 * `bodyParameterCount` (cached on save) so callers do not need to walk
 * the components array on every send.
 */

export const WHATSAPP_TEMPLATE_CATEGORIES = Object.freeze([
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
]);

export const WHATSAPP_TEMPLATE_STATUSES = Object.freeze([
  "approved",
  "pending",
  "rejected",
  "paused",
  "disabled",
]);

export const WHATSAPP_TEMPLATE_COMPONENT_TYPES = Object.freeze([
  "HEADER",
  "BODY",
  "FOOTER",
  "BUTTONS",
]);

const componentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      uppercase: true,
      enum: WHATSAPP_TEMPLATE_COMPONENT_TYPES,
    },
    format: { type: String, trim: true, maxlength: 32, default: null },
    text: { type: String, maxlength: 4_000, default: null },
    example: { type: mongoose.Schema.Types.Mixed, default: null },
    buttons: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  },
  { _id: false },
);

const whatsappTemplateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    /** Optional channel account binding. Null = available to any
     *  tenant WhatsApp account. Non-null = only sendable from that
     *  channel (for accounts with non-shared template approvals). */
    channelAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChannelAccount",
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Template name is required"],
      trim: true,
      maxlength: 512,
      lowercase: true,
    },
    language: {
      type: String,
      required: [true, "Template language is required"],
      trim: true,
      maxlength: 16,
    },
    category: {
      type: String,
      required: true,
      uppercase: true,
      enum: WHATSAPP_TEMPLATE_CATEGORIES,
    },
    status: {
      type: String,
      enum: WHATSAPP_TEMPLATE_STATUSES,
      default: "pending",
    },
    components: { type: [componentSchema], default: [] },
    /** Provider-side template id (Meta returns "id" on graph). Optional. */
    metaTemplateId: { type: String, trim: true, maxlength: 128, default: null },
    /** Cached count of positional parameters in the BODY component. */
    bodyParameterCount: { type: Number, default: 0, min: 0 },
    /** Optional rejection/disabled reason from Meta. */
    statusReason: { type: String, maxlength: 1000, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    syncedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

whatsappTemplateSchema.index(
  { tenantId: 1, name: 1, language: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    name: "whatsapp_template_name_lang_uniq",
  },
);
whatsappTemplateSchema.index({ tenantId: 1, status: 1, name: 1 });

function countBodyParameters(components = []) {
  const body = components.find((c) => c?.type === "BODY");
  if (!body?.text) return 0;
  // Match Meta's positional placeholders: {{1}}, {{2}}, ...
  const matches = String(body.text).match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  const indices = matches
    .map((m) => Number(m.replace(/[^\d]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return indices.length === 0 ? 0 : Math.max(...indices);
}

whatsappTemplateSchema.pre("validate", function preValidate() {
  this.bodyParameterCount = countBodyParameters(this.components || []);
});

whatsappTemplateSchema.statics.countBodyParameters = countBodyParameters;

const WhatsappTemplate = mongoose.model(
  "WhatsappTemplate",
  whatsappTemplateSchema,
);

export default WhatsappTemplate;
