import mongoose from "mongoose";

/**
 * PromptTemplate — versioned, tenant-scoped prompt registry used by every
 * AI surface (caption generator, lead qualifier, reply drafter, etc.).
 *
 * Versioning mirrors Workflow v2: monotonic `version`, stable `lineageId`
 * shared across versions, `previousVersionId` pointer for traceability.
 * `AIRun` pins `(promptTemplateId, promptTemplateVersion)` at run start so
 * later edits never change in-flight or already-audited generations.
 *
 * The `tenantId` is required per the tenant isolation contract. Bootstrap
 * seeds (see `services/ai/aiPromptTemplateSeeds.js`) are inserted per
 * tenant on onboarding, not as a global system row.
 */

export const PROMPT_TEMPLATE_STATUSES = Object.freeze([
  "draft",
  "active",
  "archived",
]);

export const PROMPT_TEMPLATE_CATEGORIES = Object.freeze([
  "social_caption",
  "social_hashtag_set",
  "social_calendar_idea",
  "social_product_launch",
  "social_offer",
  "social_local_business",
  "email_draft",
  "email_reply",
  "whatsapp_reply",
  "review_reply",
  "lead_qualification",
  "lead_summary",
  "classification",
  "extraction",
  "blog_post",
  "ad_copy",
  "other",
]);

const guardrailSchema = new mongoose.Schema(
  {
    /** Stable id referenced by the AI runtime guardrail registry. */
    id: { type: String, required: true, trim: true, maxlength: 128 },
    description: { type: String, trim: true, maxlength: 500, default: null },
    /** Hard guardrails block the run; soft guardrails only flag the output. */
    severity: {
      type: String,
      enum: ["hard", "soft"],
      default: "hard",
    },
  },
  { _id: false },
);

const promptTemplateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    /**
     * Stable name within the tenant. Conventions follow agent.surface, e.g.
     * `social.caption.generic`, `social.hashtag.set`, `email.reply.support`.
     */
    name: {
      type: String,
      required: [true, "Prompt template name is required"],
      trim: true,
      maxlength: 200,
      lowercase: true,
    },

    description: { type: String, trim: true, maxlength: 2000, default: null },

    category: {
      type: String,
      enum: PROMPT_TEMPLATE_CATEGORIES,
      required: true,
    },

    /** Free-form agent identifier (e.g. `social.caption_generator`). */
    agent: { type: String, trim: true, maxlength: 128, required: true },

    /** Lifecycle. */
    status: {
      type: String,
      enum: PROMPT_TEMPLATE_STATUSES,
      default: "draft",
      index: true,
    },

    /** Monotonic version per lineage. */
    version: { type: Number, default: 1, min: 1 },

    /** Stable lineage shared across versions; defaults to this doc's _id. */
    lineageId: { type: mongoose.Schema.Types.ObjectId, index: true },

    previousVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PromptTemplate",
      default: null,
    },

    /** Default model + provider for runs that do not override. */
    modelProvider: {
      type: String,
      enum: ["anthropic", "openai", "google", "azure", "local"],
      default: "anthropic",
    },
    model: { type: String, trim: true, maxlength: 128, default: null },

    /** System prompt — instructions the agent sees first. */
    systemPrompt: { type: String, maxlength: 32_000, default: "" },

    /**
     * User prompt template with `{{key}}` placeholders. Resolved at run time
     * by the context builder; missing required keys block the run.
     */
    userPromptTemplate: { type: String, maxlength: 32_000, default: "" },

    /** Names of context keys that MUST be present and non-empty before render. */
    requiredContext: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },

    /**
     * Names of context sources fed in by the context builder
     * (e.g. `brand_profile`, `crm_lead`, `trend_inputs`). Documentation /
     * traceability — not enforced by the schema.
     */
    contextSources: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },

    /**
     * Optional JSON-Schema-like object describing the structured output the
     * model is expected to return. Stored verbatim and round-tripped to the
     * runtime schema validator. Mixed because JSON Schema has no fixed shape.
     */
    outputSchema: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Optional named output schema for shared validators. */
    outputSchemaName: { type: String, trim: true, maxlength: 128, default: null },

    /** Guardrails the runtime must apply before returning the output. */
    guardrails: { type: [guardrailSchema], default: [] },

    /** Generation parameters. */
    maxTokens: { type: Number, min: 1, max: 200_000, default: null },
    temperature: { type: Number, min: 0, max: 2, default: null },

    /**
     * Whether outputs from this template require human approval before any
     * external action fires. Defaults to TRUE — the AI Contract requires
     * approval-by-default for any outbound or publish path.
     */
    requiresApproval: { type: Boolean, default: true },

    /** Plan feature flag the runtime checks before invoking. Optional. */
    planFeature: { type: String, trim: true, maxlength: 128, default: null },

    /** Free-form tags for search/grouping. */
    tags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Default lineageId to _id on first version, like Workflow.
promptTemplateSchema.pre("validate", function preValidate() {
  if (!this.lineageId) {
    this.lineageId = this._id;
  }
});

// Unique on (tenant, name, version) — only when not archived.
promptTemplateSchema.index(
  { tenantId: 1, name: 1, version: 1 },
  {
    unique: true,
    partialFilterExpression: { archivedAt: null },
    name: "prompt_template_name_version_uniq",
  },
);

promptTemplateSchema.index({ tenantId: 1, category: 1, status: 1 });
promptTemplateSchema.index({ tenantId: 1, lineageId: 1, version: -1 });

const PromptTemplate = mongoose.model("PromptTemplate", promptTemplateSchema);

export default PromptTemplate;
