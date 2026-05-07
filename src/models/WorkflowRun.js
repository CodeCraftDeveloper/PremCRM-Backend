import mongoose from "mongoose";

/**
 * WorkflowRun — single execution of a Workflow v2 graph.
 *
 * One document per run. Each node execution is a sub-document on
 * `nodeRuns` so a single Mongo round-trip surfaces full run state for
 * the UI and replay tooling.
 *
 * Pairs with the future `workflow.execute` BullMQ queue (P3-003): the
 * orchestrator job advances the run by reading `currentNodeId` and
 * appending node-run results. Per-node idempotency keys make the
 * orchestrator replay-safe per ADR-003.
 */

const NODE_RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "waiting_approval",
  "delayed",
]);

const RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

const TRIGGER_ENTITY_TYPES = Object.freeze([
  "lead",
  "contact",
  "account",
  "deal",
  "activity",
  "ticket",
  "message",
  "review",
  "social_post",
  "schedule",
  "webhook",
  "manual",
]);

const nodeRunSchema = new mongoose.Schema(
  {
    /** Matches `Workflow.nodes[].id` for this run's pinned version. */
    nodeId: { type: String, required: true, trim: true, maxlength: 64 },
    nodeType: { type: String, required: true, trim: true, maxlength: 32 },
    nodeSubtype: { type: String, required: true, trim: true, maxlength: 128 },

    status: {
      type: String,
      enum: NODE_RUN_STATUSES,
      default: "pending",
    },

    attemptsMade: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 5, min: 1 },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    /**
     * Resolved per-node idempotency key. Engine MUST set this for
     * outbound action nodes (Gmail send, WhatsApp send, GMB reply,
     * Meta publish, AI auto-action, webhook.call) per ADR-003.
     */
    idempotencyKey: { type: String, trim: true, maxlength: 256 },

    /**
     * Inputs/outputs are intentionally Mixed. Sensitive payloads (email
     * body, customer PII, AI prompts) should be redacted by the engine
     * before persistence — see Phase 11 redaction follow-up tracked in
     * the queue-failure HANDOFF notes.
     */
    input: { type: mongoose.Schema.Types.Mixed, default: null },
    output: { type: mongoose.Schema.Types.Mixed, default: null },

    error: {
      message: { type: String, default: null, maxlength: 4000 },
      stack: { type: String, default: null, maxlength: 8000 },
      nonRetryable: { type: Boolean, default: false },
    },

    /**
     * Cross-references for downstream observability. Populated by the
     * engine when the corresponding subsystem creates the related
     * record. None of these are required up-front.
     */
    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovalRequest",
      default: null,
    },
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AIRun",
      default: null,
    },
    /** BullMQ jobId for the most recent attempt (for live triage). */
    jobId: { type: String, default: null, maxlength: 128 },

    /** For delay/wait nodes — engine resumes when `waitUntil <= now`. */
    waitUntil: { type: Date, default: null },
  },
  { _id: false },
);

const workflowRunSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workflow",
      required: true,
      index: true,
    },

    /** Stable lineage across workflow versions (mirrors Workflow.lineageId). */
    workflowLineageId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    /** Pinned at run-start so edits to the workflow definition don't change in-flight runs. */
    workflowVersion: { type: Number, required: true, min: 1 },

    /**
     * Optional run-key for trigger-side dedupe. The engine builds it from
     * the trigger source so re-firing the same event collapses to a
     * single run while the previous run is in-flight (see
     * `Workflow.singleton`). Sparse + unique compound index below.
     *
     * Example shape:
     *   `${workflowId}:${triggerSource.type}:${triggerSource.entityId}`
     */
    runKey: { type: String, default: null, trim: true, maxlength: 256 },

    triggerSource: {
      type: {
        type: String,
        required: true,
        enum: [
          "on_create",
          "on_update",
          "on_stage_change",
          "on_field_change",
          "time_based",
          "webhook",
          "manual",
          "approval_resumed",
        ],
      },
      subtype: { type: String, trim: true, maxlength: 128 },
      entityType: {
        type: String,
        enum: TRIGGER_ENTITY_TYPES,
        default: "manual",
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
      payload: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    status: {
      type: String,
      enum: RUN_STATUSES,
      default: "pending",
      index: true,
    },

    /** Pointer for resume after delay/approval. Null when not started or terminal. */
    currentNodeId: { type: String, default: null, maxlength: 64 },

    /** Per-node execution log. */
    nodeRuns: { type: [nodeRunSchema], default: [] },

    /** Top-level error message for fast list-view rendering. */
    error: { type: String, default: null, maxlength: 4000 },

    /** Top-level BullMQ job id for the orchestrator. */
    queueJobId: { type: String, default: null, maxlength: 128 },

    /** Tracing correlation across orchestrator, action workers, AI runs. */
    correlationId: { type: String, default: null, maxlength: 128 },

    /** Who or what kicked this run off (admin manual replay, system, ...). */
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
workflowRunSchema.index({ tenantId: 1, workflowId: 1, createdAt: -1 });
workflowRunSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
workflowRunSchema.index({
  tenantId: 1,
  "triggerSource.entityType": 1,
  "triggerSource.entityId": 1,
});
workflowRunSchema.index(
  { tenantId: 1, workflowId: 1, runKey: 1 },
  { unique: true, partialFilterExpression: { runKey: { $type: "string" } } },
);

// 90-day TTL on createdAt — matches the legacy WorkflowExecution retention.
// Long-horizon audit lives in analytics rollups (Phase 10) and the
// FailedJob DLQ-of-record (Phase 2 P2-002).
workflowRunSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7_776_000 },
);

const WorkflowRun = mongoose.model("WorkflowRun", workflowRunSchema);

export { NODE_RUN_STATUSES, RUN_STATUSES, TRIGGER_ENTITY_TYPES };
export default WorkflowRun;
