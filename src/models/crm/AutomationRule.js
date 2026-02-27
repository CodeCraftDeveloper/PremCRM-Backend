import mongoose from "mongoose";

/**
 * CRM Automation Rule — Defines workflow triggers, conditions, and actions.
 * Async-ready / queue-compatible.
 */
const conditionSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    operator: {
      type: String,
      required: true,
      enum: [
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "greater_than",
        "less_than",
        "is_empty",
        "is_not_empty",
        "in",
        "not_in",
      ],
    },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false },
);

const actionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        "create_task",
        "update_field",
        "assign_owner",
        "send_notification",
        "webhook",
      ],
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { _id: false },
);

const automationRuleSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Rule name is required"],
      trim: true,
      maxlength: 200,
    },
    description: { type: String, maxlength: 1000 },

    isActive: { type: Boolean, default: true },

    // ── Target module ───────────────────────────────────
    module: {
      type: String,
      required: true,
      enum: ["lead", "contact", "account", "deal", "activity"],
    },

    // ── Trigger ─────────────────────────────────────────
    trigger: {
      type: {
        type: String,
        required: true,
        enum: [
          "on_create",
          "on_update",
          "on_stage_change",
          "on_field_change",
          "time_based",
        ],
      },
      config: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
        // For on_field_change: { field: "status", from: "new", to: "contacted" }
        // For time_based: { cronExpression: "0 9 * * *", condition: { ... } }
      },
    },

    // ── Conditions (all must match) ─────────────────────
    conditions: [conditionSchema],

    // ── Actions (executed in order) ─────────────────────
    actions: {
      type: [actionSchema],
      validate: {
        validator: (v) => v.length >= 1,
        message: "At least one action is required",
      },
    },

    // ── Execution stats ─────────────────────────────────
    executionCount: { type: Number, default: 0, min: 0 },
    lastExecutedAt: { type: Date, default: null },

    // ── Meta ────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Soft delete ─────────────────────────────────────
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
automationRuleSchema.index({ tenantId: 1, module: 1, isActive: 1 });
automationRuleSchema.index({ tenantId: 1, "trigger.type": 1, isActive: 1 });
automationRuleSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("AutomationRule", automationRuleSchema);
