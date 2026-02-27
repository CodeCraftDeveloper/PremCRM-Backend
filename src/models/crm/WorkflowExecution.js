import mongoose from "mongoose";

/**
 * Workflow Execution — Tracks each run of an AutomationRule.
 * Immutable log for auditing and debugging automation.
 */
const executedActionSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "skipped"],
      default: "pending",
    },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    executedAt: { type: Date, default: null },
  },
  { _id: false },
);

const workflowExecutionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationRule",
      required: true,
      index: true,
    },

    // ── Trigger context ─────────────────────────────────
    triggerEntityType: {
      type: String,
      required: true,
      enum: ["lead", "contact", "account", "deal", "activity"],
    },
    triggerEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // ── Execution status ────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },

    // ── Action results ──────────────────────────────────
    actions: [executedActionSchema],

    // ── Timing ──────────────────────────────────────────
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Error ───────────────────────────────────────────
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
workflowExecutionSchema.index({ tenantId: 1, ruleId: 1, createdAt: -1 });
workflowExecutionSchema.index({ tenantId: 1, status: 1 });
workflowExecutionSchema.index({ tenantId: 1, createdAt: -1 });

// TTL — auto-delete after 90 days
workflowExecutionSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7_776_000 },
);

export default mongoose.model("WorkflowExecution", workflowExecutionSchema);
