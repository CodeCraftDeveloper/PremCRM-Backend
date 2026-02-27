import AutomationRule from "../../models/crm/AutomationRule.js";
import WorkflowExecution from "../../models/crm/WorkflowExecution.js";
import CrmActivity from "../../models/crm/CrmActivity.js";
import Contact from "../../models/crm/Contact.js";
import Account from "../../models/crm/Account.js";
import Deal from "../../models/crm/Deal.js";
import Lead from "../../models/Lead.js";
import AuditLog from "../../models/AuditLog.js";
import logger from "../../utils/logger.js";
import { assertTenantScopedRefs } from "../../utils/tenantRefGuard.js";

/**
 * Static model registry — eliminates dynamic import() to prevent
 * path-traversal and ensures only known modules can be targeted.
 */
const MODEL_REGISTRY = {
  contact: Contact,
  deal: Deal,
  account: Account,
  lead: Lead,
  activity: CrmActivity,
};

/**
 * Allowlist of fields the update_field action may modify, per module.
 * Prevents automation rules from overwriting tenantId, deletedAt, ownerId, etc.
 */
const ALLOWED_UPDATE_FIELDS = {
  deal: ["stage", "probability", "closingDate", "status", "priority"],
  contact: ["status", "priority", "source"],
  account: ["status", "industry", "type"],
  lead: ["status", "priority", "source"],
  activity: ["status", "priority", "dueDate"],
};

/**
 * WorkflowEngine — Evaluates automation rules and executes actions.
 * Async-ready: all execution is fire-and-forget or queue-compatible.
 */
const WorkflowEngine = {
  /**
   * Fire event — finds matching rules and executes them.
   * Call this from services/controllers after mutations.
   *
   * @param {Object}  ctx
   * @param {string}  ctx.tenantId
   * @param {string}  ctx.module       — "lead" | "contact" | "account" | "deal" | "activity"
   * @param {string}  ctx.triggerType  — "on_create" | "on_update" | "on_stage_change" | "on_field_change"
   * @param {Object}  ctx.entity       — the current entity document (plain object)
   * @param {Object}  ctx.changes      — { field: { old, new } } — for update/field_change triggers
   * @param {Object}  ctx.user         — acting user
   */
  async fire(ctx) {
    // Non-blocking: defer to next tick so it doesn't slow down the response
    setImmediate(() =>
      this._process(ctx).catch((err) => {
        logger.error("[WorkflowEngine] fire error:", err.message);
      }),
    );
  },

  /**
   * Internal: find matching rules and execute.
   */
  async _process(ctx) {
    const { tenantId, module, triggerType, entity, changes = {}, user } = ctx;

    // Find active rules for this module + trigger
    const rules = await AutomationRule.find({
      tenantId,
      module,
      isActive: true,
      "trigger.type": triggerType,
      deletedAt: null,
    }).lean();

    for (const rule of rules) {
      try {
        // Check trigger config specifics
        if (!this._matchesTrigger(rule.trigger, triggerType, changes)) continue;

        // Check conditions
        if (!this._matchesConditions(rule.conditions, entity)) continue;

        // Execute
        await this._executeRule(tenantId, rule, entity, user);
      } catch (err) {
        logger.error(`[WorkflowEngine] Rule ${rule._id} error: ${err.message}`);
      }
    }
  },

  /**
   * Check if the trigger config matches the event.
   */
  _matchesTrigger(trigger, triggerType, changes) {
    if (triggerType === "on_create" || triggerType === "on_update") return true;

    if (triggerType === "on_field_change" && trigger.config?.field) {
      const fieldChange = changes[trigger.config.field];
      if (!fieldChange) return false;
      if (trigger.config.from && fieldChange.old !== trigger.config.from)
        return false;
      if (trigger.config.to && fieldChange.new !== trigger.config.to)
        return false;
      return true;
    }

    if (triggerType === "on_stage_change" && trigger.config) {
      const stageChange = changes.stage;
      if (!stageChange) return false;
      if (trigger.config.from && stageChange.old !== trigger.config.from)
        return false;
      if (trigger.config.to && stageChange.new !== trigger.config.to)
        return false;
      return true;
    }

    return true;
  },

  /**
   * Evaluate conditions against entity data.
   */
  _matchesConditions(conditions, entity) {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every((cond) => {
      const value = entity[cond.field];
      switch (cond.operator) {
        case "equals":
          return value == cond.value; // loose comparison intentional
        case "not_equals":
          return value != cond.value;
        case "contains":
          return String(value || "").includes(String(cond.value));
        case "not_contains":
          return !String(value || "").includes(String(cond.value));
        case "greater_than":
          return Number(value) > Number(cond.value);
        case "less_than":
          return Number(value) < Number(cond.value);
        case "is_empty":
          return value === undefined || value === null || value === "";
        case "is_not_empty":
          return value !== undefined && value !== null && value !== "";
        case "in":
          return Array.isArray(cond.value) && cond.value.includes(value);
        case "not_in":
          return Array.isArray(cond.value) && !cond.value.includes(value);
        default:
          return true;
      }
    });
  },

  /**
   * Execute all actions for a matched rule.
   */
  async _executeRule(tenantId, rule, entity, user) {
    const execution = await WorkflowExecution.create({
      tenantId,
      ruleId: rule._id,
      triggerEntityType: rule.module,
      triggerEntityId: entity._id,
      status: "running",
      startedAt: new Date(),
      actions: rule.actions.map((a) => ({ type: a.type, status: "pending" })),
    });

    let allSuccess = true;

    for (let i = 0; i < rule.actions.length; i++) {
      const action = rule.actions[i];
      try {
        const result = await this._executeAction(
          tenantId,
          action,
          entity,
          user,
        );
        execution.actions[i].status = "completed";
        execution.actions[i].result = result;
        execution.actions[i].executedAt = new Date();
      } catch (err) {
        execution.actions[i].status = "failed";
        execution.actions[i].error = err.message;
        execution.actions[i].executedAt = new Date();
        allSuccess = false;
      }
    }

    execution.status = allSuccess ? "completed" : "failed";
    execution.completedAt = new Date();
    await execution.save();

    // Update rule stats
    await AutomationRule.updateOne(
      { _id: rule._id },
      { $inc: { executionCount: 1 }, $set: { lastExecutedAt: new Date() } },
    );

    return execution;
  },

  /**
   * Execute a single action.
   */
  async _executeAction(tenantId, action, entity, user) {
    switch (action.type) {
      case "create_task": {
        const task = await CrmActivity.create({
          tenantId,
          type: "task",
          subject:
            action.config.subject ||
            `Follow up: ${entity.name || entity.fullName || ""}`,
          description: action.config.description || "",
          status: "planned",
          priority: action.config.priority || "medium",
          dueDate: action.config.dueDays
            ? new Date(Date.now() + action.config.dueDays * 86400000)
            : null,
          ownerId: action.config.assignTo || entity.ownerId || user._id,
          relatedTo: {
            entityType: action.config.entityType || "deal",
            entityId: entity._id,
          },
        });
        return { taskId: task._id };
      }

      case "update_field": {
        // Validate field is in the allowlist to prevent updating protected fields
        const moduleName = (action.config.module || "deal").toLowerCase();
        const allowed = ALLOWED_UPDATE_FIELDS[moduleName] || [];
        if (!allowed.includes(action.config.field)) {
          const msg = `[WorkflowEngine] Blocked update_field: "${action.config.field}" is not allowed for module "${moduleName}"`;
          logger.warn(msg);
          throw new Error(msg);
        }

        // Resolve model from static registry — no dynamic import
        const Model = MODEL_REGISTRY[moduleName];
        if (!Model) {
          throw new Error(`[WorkflowEngine] Unknown module: "${moduleName}"`);
        }
        await Model.updateOne(
          { _id: entity._id, tenantId },
          { $set: { [action.config.field]: action.config.value } },
        );
        return { field: action.config.field, value: action.config.value };
      }

      case "assign_owner": {
        // Validate the new ownerId belongs to the same tenant
        await assertTenantScopedRefs(tenantId, "deals", {
          ownerId: action.config.ownerId,
        });

        const ownerModel =
          MODEL_REGISTRY[(action.config.module || "deal").toLowerCase()];
        if (!ownerModel) {
          throw new Error(
            `[WorkflowEngine] Unknown module for assign_owner: "${action.config.module}"`,
          );
        }
        await ownerModel.updateOne(
          { _id: entity._id, tenantId },
          { $set: { ownerId: action.config.ownerId } },
        );
        return { newOwnerId: action.config.ownerId };
      }

      case "send_notification": {
        // Placeholder — log the notification intent
        logger.info("[WorkflowEngine] Notification:", {
          tenantId,
          to: action.config.to,
          message: action.config.message,
          entityId: entity._id,
        });
        return { notified: true, to: action.config.to };
      }

      case "webhook": {
        // Placeholder — would call external webhook
        logger.info("[WorkflowEngine] Webhook trigger:", {
          url: action.config.url,
          entityId: entity._id,
        });
        return { webhookUrl: action.config.url, triggered: true };
      }

      default:
        return { skipped: true, reason: `Unknown action type: ${action.type}` };
    }
  },
};

export default WorkflowEngine;
