/**
 * Workflow v1 → v2 migration helpers.
 *
 * The legacy `AutomationRule` (v1) supports a flat shape:
 *   trigger { type, config } + conditions[] + actions[]
 *
 * Workflow v2 is a graph of typed nodes. This module is the
 * deterministic, side-effect-free mapper from v1 → v2.
 *
 * Used by:
 *  - The migration runner (lands when we move CRM rules onto v2 in
 *    P3-003 — explicitly out of scope for P3-001).
 *  - The compatibility test (`workflow-v2-models.test.js`).
 *  - Optional `Workflow.migratedFromAutomationRuleId` lineage field.
 *
 * No DB writes. Returns a plain object suitable for `Workflow.create()`.
 */

const TRIGGER_TYPE_TO_SUBTYPE = Object.freeze({
  on_create: "on_create",
  on_update: "on_update",
  on_stage_change: "on_stage_change",
  on_field_change: "on_field_change",
  time_based: "time_based",
});

const ACTION_TYPE_TO_SUBTYPE = Object.freeze({
  create_task: "action.crm.create_task",
  update_field: "action.crm.update_field",
  assign_owner: "action.crm.assign_owner",
  send_notification: "action.notification.send",
  webhook: "action.webhook.call",
});

/**
 * Build a stable node id given a deterministic prefix and index.
 * Keeping the format short and readable is intentional — these IDs
 * appear in `WorkflowRun.nodeRuns[].nodeId` and in audit logs.
 */
function makeNodeId(prefix, index) {
  return `${prefix}_${index}`;
}

/**
 * Map an `AutomationRule` document (or POJO) to a Workflow v2 definition
 * payload. Pure function: never reads or writes the database.
 *
 * Output shape (subset of `Workflow.create()` input):
 *   {
 *     tenantId,
 *     name,
 *     description,
 *     status: "draft",
 *     isActive,
 *     nodes: [trigger, ...conditionGuards, ...actions],
 *     edges: [linear chain],
 *     migratedFromAutomationRuleId,
 *     createdBy,
 *   }
 *
 * Conditions are folded into a single `condition.expression` node
 * because v1 semantics are "all conditions must match" — that's a
 * straight AND, which the v2 expression evaluator (P3-002) handles
 * natively. We keep the original `conditions` array on the node config
 * so the registry can emit a deterministic boolean expression without
 * re-parsing v1 enums.
 */
export function mapAutomationRuleToWorkflowDefinition(rule, options = {}) {
  if (!rule || typeof rule !== "object") {
    throw new Error("mapAutomationRuleToWorkflowDefinition: rule is required");
  }
  if (!rule.tenantId) {
    throw new Error(
      "mapAutomationRuleToWorkflowDefinition: rule.tenantId is required",
    );
  }
  if (!rule.module) {
    throw new Error(
      "mapAutomationRuleToWorkflowDefinition: rule.module is required",
    );
  }
  if (!rule.trigger || !rule.trigger.type) {
    throw new Error(
      "mapAutomationRuleToWorkflowDefinition: rule.trigger.type is required",
    );
  }
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    throw new Error(
      "mapAutomationRuleToWorkflowDefinition: rule.actions must be non-empty",
    );
  }

  const triggerSubtypeRoot = TRIGGER_TYPE_TO_SUBTYPE[rule.trigger.type];
  if (!triggerSubtypeRoot) {
    throw new Error(
      `mapAutomationRuleToWorkflowDefinition: unknown trigger type "${rule.trigger.type}"`,
    );
  }

  const triggerSubtype = `trigger.${rule.module}.${triggerSubtypeRoot}`;

  const triggerNode = {
    id: makeNodeId("trigger", 0),
    type: "trigger",
    subtype: triggerSubtype,
    label: `${rule.module} ${triggerSubtypeRoot}`,
    config: {
      module: rule.module,
      v1TriggerType: rule.trigger.type,
      v1TriggerConfig: rule.trigger.config || {},
    },
    position: { x: 0, y: 0 },
  };

  const hasConditions =
    Array.isArray(rule.conditions) && rule.conditions.length > 0;

  const conditionNode = hasConditions
    ? {
        id: makeNodeId("condition", 0),
        type: "condition",
        subtype: "condition.expression",
        label: `Match ${rule.conditions.length} condition${rule.conditions.length === 1 ? "" : "s"}`,
        config: {
          combinator: "AND",
          conditions: rule.conditions.map((c) => ({
            field: c.field,
            operator: c.operator,
            value: c.value,
          })),
        },
        position: { x: 1, y: 0 },
      }
    : null;

  const actionNodes = rule.actions.map((action, idx) => {
    const subtype =
      ACTION_TYPE_TO_SUBTYPE[action.type] || `action.unknown.${action.type}`;
    return {
      id: makeNodeId("action", idx),
      type: "action",
      subtype,
      label: action.type,
      config: {
        v1ActionType: action.type,
        ...(action.config || {}),
      },
      position: { x: 2 + idx, y: 0 },
    };
  });

  const nodes = [
    triggerNode,
    ...(conditionNode ? [conditionNode] : []),
    ...actionNodes,
  ];

  // Linear edges: trigger -> [condition] -> action0 -> action1 -> ...
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({
      id: `e_${i}`,
      from: nodes[i].id,
      to: nodes[i + 1].id,
    });
  }

  return {
    tenantId: rule.tenantId,
    name: rule.name || `Migrated rule ${rule._id || ""}`.trim(),
    description: rule.description || "",
    status: "draft",
    isActive: rule.isActive !== false,
    nodes,
    edges,
    migratedFromAutomationRuleId: rule._id || null,
    createdBy: options.createdBy || rule.createdBy || null,
  };
}

export const __TEST_ONLY__ = Object.freeze({
  TRIGGER_TYPE_TO_SUBTYPE,
  ACTION_TYPE_TO_SUBTYPE,
});
