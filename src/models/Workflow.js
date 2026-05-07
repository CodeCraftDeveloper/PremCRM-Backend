import mongoose from "mongoose";

/**
 * Workflow v2 — graph-based automation definition.
 *
 * Supersedes the legacy `AutomationRule` model used by the in-process
 * `core/crm/WorkflowEngine.js`. v2 supports trigger / condition / action /
 * AI / approval / delay / branch nodes connected by typed edges, version
 * pinning at run start (`WorkflowRun.workflowVersion`), per-node retry
 * policy and idempotency-key templates, and soft delete.
 *
 * v1 (`AutomationRule`) continues to work in parallel until P3-003 moves
 * execution onto the `workflow.execute` BullMQ queue.
 */

const NODE_TYPES = Object.freeze([
  "trigger",
  "condition",
  "action",
  "ai",
  "approval",
  "delay",
  "branch",
]);

/**
 * Trigger / action subtype namespace. Kept open here (free-form String) so
 * domain phases can register new subtypes without schema migrations. The
 * action registry from P3-002 is the source of truth for valid subtypes;
 * the engine validates against the registry at compile time.
 *
 * Conventions:
 *   trigger.<entity>.<event>      e.g. trigger.lead.created
 *   trigger.crm.<event>           e.g. trigger.crm.deal_stage_change
 *   trigger.gmail.message_received
 *   trigger.whatsapp.message_received
 *   trigger.gmb.review_received
 *   trigger.schedule.cron         e.g. cron-driven via BullMQ repeat jobs
 *   trigger.webhook.external
 *
 *   action.crm.update_field
 *   action.crm.assign_owner
 *   action.crm.create_task
 *   action.notification.send
 *   action.gmail.send             (Phase 5; requires approval)
 *   action.whatsapp.send          (Phase 6; requires approval)
 *   action.meta.publish           (Phase 9; requires approval)
 *   action.gmb.reply              (Phase 8; requires approval)
 *   action.webhook.call
 *
 *   ai.draft.<surface>            e.g. ai.draft.email
 *   ai.classify.<surface>         e.g. ai.classify.lead_quality
 *
 *   condition.expression
 *   approval.request
 *   delay.wait
 *   branch.switch
 */

const retryPolicySchema = new mongoose.Schema(
  {
    attempts: { type: Number, min: 1, max: 25, default: 5 },
    backoffMs: { type: Number, min: 0, max: 86_400_000, default: 1000 },
    backoffStrategy: {
      type: String,
      enum: ["exponential", "fixed"],
      default: "exponential",
    },
  },
  { _id: false },
);

const nodeSchema = new mongoose.Schema(
  {
    /** Stable string ID — referenced by edges and WorkflowRun.nodeRuns. */
    id: { type: String, required: true, trim: true, maxlength: 64 },

    type: { type: String, required: true, enum: NODE_TYPES },

    /**
     * Subtype within the type namespace. Validated against the action
     * registry at compile time (P3-002), not at the schema layer, so new
     * subtypes can ship without schema migrations.
     */
    subtype: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },

    /** Human label for the builder UI. */
    label: { type: String, trim: true, maxlength: 200 },

    /** Per-subtype config payload. Validated by the action registry. */
    config: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    /** Optional builder-canvas position. */
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },

    /** Per-node retry override. Falls back to queue-level RETRY_POLICIES. */
    retryPolicy: { type: retryPolicySchema, default: undefined },

    /**
     * Mustache-style template for the per-node idempotency key. Resolved
     * at run time — must be unique per (run, node attempt batch). When
     * empty the engine falls back to `${run._id}:${node.id}`.
     *
     * Example: `gmail-send:${run._id}:${node.id}:${context.message.id}`.
     */
    idempotencyKeyTemplate: { type: String, trim: true, maxlength: 256 },

    /**
     * If true the engine treats this node as requiring human approval
     * before downstream nodes execute. Mirrors `approval` node type for
     * convenience on action nodes (e.g. action.gmail.send with
     * `requiresApproval: true`).
     */
    requiresApproval: { type: Boolean, default: false },
  },
  { _id: false },
);

const edgeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    from: { type: String, required: true, trim: true, maxlength: 64 },
    to: { type: String, required: true, trim: true, maxlength: 64 },
    /**
     * Optional branch label. For `branch.switch` nodes this is one of
     * the case keys; for normal action edges it can encode a "success"
     * vs "failure" path.
     */
    label: { type: String, trim: true, maxlength: 64 },
    /**
     * Optional expression evaluated at runtime to gate this edge. Engine
     * skips the edge when the expression returns falsy. Source of truth
     * is the action registry's expression evaluator (P3-002).
     */
    condition: { type: String, trim: true, maxlength: 1024 },
  },
  { _id: false },
);

const workflowSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Workflow name is required"],
      trim: true,
      maxlength: 200,
    },
    description: { type: String, maxlength: 2000 },

    /**
     * Lifecycle. `draft` is editable, `active` is executable and immutable
     * (a new version is created on edit), `archived` is read-only.
     */
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
      index: true,
    },

    /** Convenience switch for active workflows; matches v1 `isActive`. */
    isActive: { type: Boolean, default: true },

    /**
     * Monotonic version per workflow lineage. Incremented when an active
     * workflow is edited (a new document is created and the prior one
     * archived). Pinned in `WorkflowRun.workflowVersion`.
     */
    version: { type: Number, default: 1, min: 1 },

    /**
     * Stable lineage ID shared across versions of the same workflow.
     * Defaults to this document's `_id` for the first version. UI shows
     * version history by querying `{ tenantId, lineageId }`.
     */
    lineageId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },

    /** Pointer to the previous version document, for traceability. */
    previousVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workflow",
      default: null,
    },

    /** Graph definition. */
    nodes: {
      type: [nodeSchema],
      validate: {
        validator(nodes) {
          if (!Array.isArray(nodes) || nodes.length === 0) return false;
          // Unique node IDs.
          const ids = new Set();
          for (const n of nodes) {
            if (ids.has(n.id)) return false;
            ids.add(n.id);
          }
          // At least one trigger node.
          return nodes.some((n) => n.type === "trigger");
        },
        message:
          "Workflow must have at least one trigger node and unique node IDs.",
      },
    },

    edges: {
      type: [edgeSchema],
      default: [],
      validate: {
        validator(edges) {
          if (!Array.isArray(edges)) return false;
          const ids = new Set();
          for (const e of edges) {
            if (ids.has(e.id)) return false;
            ids.add(e.id);
          }
          return true;
        },
        message: "Edge IDs must be unique.",
      },
    },

    /**
     * Denormalized list of trigger subtypes for fast trigger-time lookup.
     * Maintained by the engine on save; we also index it.
     */
    triggerSubtypes: {
      type: [String],
      default: [],
      index: true,
    },

    /**
     * If true the engine prevents concurrent runs against the same
     * trigger entity (lead/contact/deal/...). Implemented at run-start
     * via the `runKey` unique index on `WorkflowRun`.
     */
    singleton: { type: Boolean, default: false },

    /** Per-workflow concurrency cap inside the BullMQ worker (0 = unlimited). */
    maxConcurrency: { type: Number, min: 0, max: 1000, default: 0 },

    /**
     * v1 compatibility lineage. When set, this workflow was generated
     * from an `AutomationRule`. The migration runner sets this once;
     * subsequent edits keep the pointer for audit.
     */
    migratedFromAutomationRuleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationRule",
      default: null,
    },

    /** Run statistics — best-effort counters; not authoritative. */
    stats: {
      runCount: { type: Number, default: 0, min: 0 },
      successCount: { type: Number, default: 0, min: 0 },
      failureCount: { type: Number, default: 0, min: 0 },
      lastRunAt: { type: Date, default: null },
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

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
workflowSchema.index({ tenantId: 1, status: 1, isActive: 1 });
workflowSchema.index({ tenantId: 1, triggerSubtypes: 1, status: 1 });
workflowSchema.index({ tenantId: 1, lineageId: 1, version: -1 });
workflowSchema.index({ tenantId: 1, createdAt: -1 });
workflowSchema.index({ tenantId: 1, migratedFromAutomationRuleId: 1 });

/**
 * Maintain `lineageId` and `triggerSubtypes` automatically.
 *  - On first insert without a lineageId we point it at this document's _id
 *    so v1 of a workflow has `lineageId === _id`.
 *  - `triggerSubtypes` is denormalized from `nodes[type=trigger]` for
 *    indexed trigger-time lookup.
 */
workflowSchema.pre("validate", function preValidateWorkflow() {
  if (!this.lineageId) this.lineageId = this._id;

  if (Array.isArray(this.nodes)) {
    const subtypes = this.nodes
      .filter((n) => n && n.type === "trigger" && n.subtype)
      .map((n) => n.subtype);
    this.triggerSubtypes = Array.from(new Set(subtypes));
  }
});

const Workflow = mongoose.model("Workflow", workflowSchema);

export { NODE_TYPES };
export default Workflow;
