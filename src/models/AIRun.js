import mongoose from "mongoose";

/**
 * AIRun — durable audit record of a single AI invocation.
 *
 * Every AI surface (caption generator, reply drafter, classifier, etc.)
 * MUST persist an AIRun before calling the model and update it once the
 * model returns. AIRun is the source of truth for:
 *
 *   - Prompt template + version pinning (links to PromptTemplate)
 *   - Structured output capture and confidence
 *   - Risk flags and guardrail blocks
 *   - Token + cost usage (mirrors UsageMeter aiRuns / aiTokens metering)
 *   - Approval gate linkage (links to ApprovalRequest)
 *   - Workflow node correlation when invoked by a workflow run
 *   - Cross-tenant safety: tenantId is required and indexed
 *
 * AIRun is the entity referenced by `WorkflowRun.nodeRuns[].aiRunId` and
 * by `ApprovalRequest.aiRunId`. The AI orchestration layer (P7-002+) is
 * the only writer; downstream consumers read for audit/UI/billing.
 */

export const AI_RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked_by_guardrail",
  "cancelled",
]);

export const AI_MODEL_PROVIDERS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "azure",
  "local",
]);

const aiUsageSchema = new mongoose.Schema(
  {
    promptTokens: { type: Number, min: 0, default: 0 },
    completionTokens: { type: Number, min: 0, default: 0 },
    totalTokens: { type: Number, min: 0, default: 0 },
    /** Stored as integer micro-USD to avoid float drift. 1 USD = 1_000_000. */
    costMicroUsd: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const aiContextSourceSchema = new mongoose.Schema(
  {
    /**
     * Type of source. Free-form so phases can register new sources without
     * a schema change. Examples: `brand_profile`, `crm_lead`, `crm_deal`,
     * `trend_input`, `inbox_message`, `gmb_review`, `manual_input`.
     */
    type: { type: String, required: true, trim: true, maxlength: 64 },
    /** Optional reference id to the source document. */
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Optional human-readable label for audit/UI. */
    label: { type: String, trim: true, maxlength: 256, default: null },
    /** Whether the source was tenant-approved (relevant for trends). */
    approved: { type: Boolean, default: true },
  },
  { _id: false },
);

const aiRunSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    /** Stable agent identifier — e.g. `social.caption_generator`. */
    agent: {
      type: String,
      required: [true, "AI run agent is required"],
      trim: true,
      maxlength: 128,
    },

    /** Pinned prompt template — version is captured in `promptTemplateVersion`. */
    promptTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PromptTemplate",
      default: null,
    },
    promptTemplateName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    promptTemplateVersion: { type: Number, min: 1, required: true },
    /** Stable lineage so a UI can group runs across template versions. */
    promptTemplateLineageId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    /** Concrete model + provider used for this run. */
    modelProvider: { type: String, enum: AI_MODEL_PROVIDERS, required: true },
    model: { type: String, trim: true, maxlength: 128, required: true },

    status: {
      type: String,
      enum: AI_RUN_STATUSES,
      default: "pending",
      index: true,
    },

    /**
     * Resolved input the runtime passed to the model. May be redacted by
     * the orchestration layer before persistence — store summaries, not
     * raw PII, when the surface handles sensitive content.
     */
    input: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Structured model output (validated against PromptTemplate.outputSchema). */
    output: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Context sources that fed into the prompt. Used for traceability. */
    contextSources: { type: [aiContextSourceSchema], default: [] },

    /** Confidence in [0, 1]; null when the agent does not report it. */
    confidence: { type: Number, min: 0, max: 1, default: null },

    /** Risk flags (free-form strings: `medical_claim`, `unverified_offer`, ...). */
    riskFlags: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },

    /**
     * Whether this run's output requires human approval before any
     * external action fires. Mirrors `PromptTemplate.requiresApproval`
     * but allows per-run override (e.g. when tenant policy auto-approves
     * a low-risk class). Defaults to TRUE.
     */
    requiresApproval: { type: Boolean, default: true },

    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovalRequest",
      default: null,
    },

    /** Optional draft persistence link. Bidirectional with ContentDraft. */
    contentDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContentDraft",
      default: null,
    },

    /** Workflow correlation when the run was kicked off by a workflow node. */
    workflowRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkflowRun",
      default: null,
    },
    workflowNodeId: { type: String, trim: true, maxlength: 64, default: null },

    usage: { type: aiUsageSchema, default: () => ({}) },

    /** Provider request id captured for support / replay. */
    providerRequestId: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    error: {
      message: { type: String, default: null, maxlength: 4000 },
      code: { type: String, default: null, maxlength: 128 },
      nonRetryable: { type: Boolean, default: false },
    },

    /** Guardrail block details when status === blocked_by_guardrail. */
    guardrailBlock: {
      guardrailId: { type: String, default: null, maxlength: 128 },
      reason: { type: String, default: null, maxlength: 1000 },
    },

    /** Tracing correlation across orchestrator, workflow, approval queue. */
    correlationId: { type: String, default: null, maxlength: 128 },

    /** Idempotency key — same (tenantId, idempotencyKey) collapses replays. */
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    triggeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
aiRunSchema.index({ tenantId: 1, createdAt: -1 });
aiRunSchema.index({ tenantId: 1, agent: 1, createdAt: -1 });
aiRunSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
aiRunSchema.index({ tenantId: 1, workflowRunId: 1, createdAt: -1 });
aiRunSchema.index({ tenantId: 1, contentDraftId: 1, createdAt: -1 });

// Idempotency: per-tenant, sparse + unique on idempotencyKey when present.
aiRunSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "ai_run_idempotency_uniq",
  },
);

// 90-day TTL on createdAt — matches WorkflowRun retention. Long-horizon
// audit lives in analytics rollups (Phase 10). Cost/usage aggregation is
// done by UsageMeter increments, not by scanning AIRun history.
aiRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 });

const AIRun = mongoose.model("AIRun", aiRunSchema);

export default AIRun;
