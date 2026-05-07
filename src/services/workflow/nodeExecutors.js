/**
 * Node executors for Workflow v2 (P3-003).
 *
 * Each executor is a pure async function:
 *   async (ctx) => { input, output, error? }
 *
 * ctx shape:
 *   {
 *     tenantId,        — ObjectId string
 *     node,            — the Workflow.nodes[] sub-doc (id, type, subtype, config, …)
 *     run,             — the WorkflowRun document
 *     triggerSource,   — WorkflowRun.triggerSource
 *     entity,          — resolved trigger entity (may be null for manual/webhook)
 *     user,            — triggering user (may be null)
 *     nodeRun,         — the current WorkflowRun.nodeRuns[] sub-doc
 *   }
 *
 * CRM action executors reuse the v1 WorkflowEngine action logic to
 * preserve backwards compatibility — they are thin wrappers that call
 * the same Mongoose operations but return structured output for the
 * nodeRun log.
 *
 * Preview-status nodes (provider outbound, AI) are NOT registered here.
 * The orchestrator refuses them before dispatch.
 */

import CrmActivity from "../../models/crm/CrmActivity.js";
import Contact from "../../models/crm/Contact.js";
import Account from "../../models/crm/Account.js";
import Deal from "../../models/crm/Deal.js";
import Lead from "../../models/Lead.js";
import logger from "../../utils/logger.js";
import { NonRetryableError } from "../../queue/errors.js";

// ── Static model registry (matches v1 WorkflowEngine) ───────────────────
const MODEL_REGISTRY = {
  contact: Contact,
  deal: Deal,
  account: Account,
  lead: Lead,
  activity: CrmActivity,
};

const ALLOWED_UPDATE_FIELDS = {
  deal: ["stage", "probability", "closingDate", "status", "priority"],
  contact: ["status", "priority", "source"],
  account: ["status", "industry", "type"],
  lead: ["status", "priority", "source"],
  activity: ["status", "priority", "dueDate"],
};

// ── Condition executor ──────────────────────────────────────────────────

function evaluateCondition(condition, entity) {
  if (!entity) return true;
  const value = entity[condition.field];
  switch (condition.operator) {
    case "equals":
      return value == condition.value;
    case "not_equals":
      return value != condition.value;
    case "contains":
      return String(value || "").includes(String(condition.value));
    case "not_contains":
      return !String(value || "").includes(String(condition.value));
    case "greater_than":
      return Number(value) > Number(condition.value);
    case "less_than":
      return Number(value) < Number(condition.value);
    case "is_empty":
      return value === undefined || value === null || value === "";
    case "is_not_empty":
      return value !== undefined && value !== null && value !== "";
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(value);
    case "not_in":
      return Array.isArray(condition.value) && !condition.value.includes(value);
    default:
      return true;
  }
}

async function executeConditionExpression(ctx) {
  const { config = {} } = ctx.node;
  const { combinator = "AND", conditions = [] } = config;
  const entity = ctx.entity || ctx.triggerSource?.payload || {};

  const input = { combinator, conditionCount: conditions.length };
  let passed;

  if (combinator === "OR") {
    passed = conditions.length === 0 || conditions.some((c) => evaluateCondition(c, entity));
  } else {
    passed = conditions.every((c) => evaluateCondition(c, entity));
  }

  return {
    input,
    output: { passed },
  };
}

// ── CRM action executors ────────────────────────────────────────────────

async function executeCreateTask(ctx) {
  const { tenantId, node, entity, user } = ctx;
  const config = node.config || {};

  const task = await CrmActivity.create({
    tenantId,
    type: "task",
    subject: config.title || config.subject || `Follow up: ${entity?.name || entity?.fullName || ""}`,
    description: config.description || "",
    status: "planned",
    priority: config.priority || "medium",
    dueDate: config.dueInDays
      ? new Date(Date.now() + config.dueInDays * 86400000)
      : null,
    ownerId: config.ownerId || entity?.ownerId || user?._id || null,
    relatedTo: {
      entityType: config.entityType || "deal",
      entityId: entity?._id || null,
    },
  });

  return {
    input: { title: config.title, dueInDays: config.dueInDays },
    output: { taskId: task._id.toString() },
  };
}

async function executeUpdateField(ctx) {
  const { tenantId, node, entity } = ctx;
  const config = node.config || {};
  const moduleName = (config.module || "deal").toLowerCase();
  const allowed = ALLOWED_UPDATE_FIELDS[moduleName] || [];

  if (!allowed.includes(config.field)) {
    throw new NonRetryableError(
      `update_field: field "${config.field}" not allowed for module "${moduleName}"`,
    );
  }

  const Model = MODEL_REGISTRY[moduleName];
  if (!Model) {
    throw new NonRetryableError(
      `update_field: unknown module "${moduleName}"`,
    );
  }

  if (!entity?._id) {
    throw new NonRetryableError("update_field: no entity to update");
  }

  await Model.updateOne(
    { _id: entity._id, tenantId },
    { $set: { [config.field]: config.value } },
  );

  return {
    input: { field: config.field, value: config.value, module: moduleName },
    output: { updated: true },
  };
}

async function executeAssignOwner(ctx) {
  const { tenantId, node, entity } = ctx;
  const config = node.config || {};
  const moduleName = (config.module || "deal").toLowerCase();

  const Model = MODEL_REGISTRY[moduleName];
  if (!Model) {
    throw new NonRetryableError(
      `assign_owner: unknown module "${moduleName}"`,
    );
  }

  if (!entity?._id) {
    throw new NonRetryableError("assign_owner: no entity to update");
  }

  const newOwnerId = config.ownerId || entity?.ownerId || null;
  if (newOwnerId) {
    await Model.updateOne(
      { _id: entity._id, tenantId },
      { $set: { ownerId: newOwnerId } },
    );
  }

  return {
    input: { ownerId: config.ownerId, module: moduleName },
    output: { newOwnerId },
  };
}

async function executeNotificationSend(ctx) {
  const { tenantId, node, entity } = ctx;
  const config = node.config || {};

  // Placeholder — log intent. Real notification worker lands in Phase 4+.
  logger.info("[WorkflowExecutor] Notification:", {
    tenantId,
    to: config.recipientUserId || config.recipientRole || "owner",
    title: config.title,
    entityId: entity?._id?.toString() || null,
  });

  return {
    input: { title: config.title, recipientRole: config.recipientRole },
    output: { notified: true },
  };
}

async function executeWebhookCall(ctx) {
  const { node, entity } = ctx;
  const config = node.config || {};

  // Placeholder — log intent. Real webhook execution with SSRF protection
  // lands when the outbound HTTP adapter is built.
  logger.info("[WorkflowExecutor] Webhook call:", {
    url: config.url,
    method: config.method || "POST",
    entityId: entity?._id?.toString() || null,
  });

  return {
    input: { url: config.url, method: config.method || "POST" },
    output: { triggered: true, webhookUrl: config.url },
  };
}

// ── Delay executor ──────────────────────────────────────────────────────

async function executeDelayWait(ctx) {
  const { node } = ctx;
  const config = node.config || {};
  const durationMs = config.durationMs || 0;
  const waitUntil = new Date(Date.now() + durationMs);

  return {
    input: { durationMs },
    output: { waitUntil: waitUntil.toISOString(), delayed: true },
    waitUntil,
  };
}

// ── Approval executor ───────────────────────────────────────────────────

async function executeApprovalRequest(ctx) {
  const { node } = ctx;
  const config = node.config || {};

  // Placeholder — real approval request model lands in Phase 7.
  // For now, mark as waiting_approval and pause.
  return {
    input: {
      approverRole: config.approverRole || "admin",
      message: config.message || "",
    },
    output: { awaitingApproval: true },
    waitingApproval: true,
  };
}

// ── Branch executor ─────────────────────────────────────────────────────

async function executeBranchSwitch(ctx) {
  const { node, entity, triggerSource } = ctx;
  const config = node.config || {};
  const data = entity || triggerSource?.payload || {};

  // Simple expression evaluation: extract field value from entity.
  // In Phase 7+ this becomes a real expression evaluator.
  const expressionField = config.expression || "";
  const value = data[expressionField];
  const strValue = String(value ?? "");

  const matchedCase = (config.cases || []).find(
    (c) => c.value !== undefined && String(c.value) === strValue,
  );
  const selectedLabel = matchedCase?.label || config.defaultLabel || null;

  return {
    input: { expression: expressionField, value: strValue },
    output: { selectedLabel, matchedValue: strValue },
    branchLabel: selectedLabel,
  };
}

// ── Executor dispatch table ─────────────────────────────────────────────

const EXECUTOR_MAP = Object.freeze({
  "condition.expression": executeConditionExpression,
  "action.crm.create_task": executeCreateTask,
  "action.crm.update_field": executeUpdateField,
  "action.crm.assign_owner": executeAssignOwner,
  "action.notification.send": executeNotificationSend,
  "action.webhook.call": executeWebhookCall,
  "delay.wait": executeDelayWait,
  "approval.request": executeApprovalRequest,
  "branch.switch": executeBranchSwitch,
});

/**
 * Get the executor function for a subtype.
 * Returns null for unknown / preview subtypes.
 */
export function getNodeExecutor(subtype) {
  return EXECUTOR_MAP[subtype] || null;
}

/**
 * Check if a subtype has a registered executor.
 */
export function hasExecutor(subtype) {
  return subtype in EXECUTOR_MAP;
}

/**
 * List all registered executor subtypes.
 */
export function listExecutors() {
  return Object.keys(EXECUTOR_MAP).sort();
}

export { EXECUTOR_MAP };
