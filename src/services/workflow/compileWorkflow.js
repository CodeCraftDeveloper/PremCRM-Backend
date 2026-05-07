/**
 * compileWorkflow — validates a Workflow v2 graph against the action
 * registry. Pure function; never reads or writes the database.
 *
 * Used by:
 *   - The workflow save endpoint (Phase 11 builder UI) to refuse invalid
 *     graphs before persisting.
 *   - The migration runner to fail fast when an unmapped v1 action would
 *     produce an `action.unknown.<type>` subtype.
 *   - The `workflow.execute` orchestrator (P3-003) to refuse execution of
 *     workflows whose nodes reference a `preview`-status subtype that has
 *     no registered processor yet.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     errors: [{ scope: "node"|"edge"|"workflow", id, message }],
 *     warnings: [{ scope, id, message }],   // e.g. preview subtypes
 *     summary: {
 *       triggerSubtypes: [...],
 *       requiresApproval: boolean,          // any node requires approval
 *       planFeatures: [...],                 // distinct features used
 *       queues: [...],                       // distinct BullMQ queues used
 *     }
 *   }
 */

import { getRegistryEntry, validateNodeConfig } from "./actionRegistry.js";

function pushError(errors, scope, id, message) {
  errors.push({ scope, id, message });
}

function pushWarning(warnings, scope, id, message) {
  warnings.push({ scope, id, message });
}

/**
 * Validate a workflow graph against the action registry.
 *
 * Accepts either a Mongoose Workflow document or a plain object with at
 * minimum `{ nodes, edges }`. Read-only.
 */
export function compileWorkflow(workflow) {
  const errors = [];
  const warnings = [];

  if (!workflow || typeof workflow !== "object") {
    return {
      ok: false,
      errors: [
        { scope: "workflow", id: null, message: "workflow is required" },
      ],
      warnings,
      summary: null,
    };
  }

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  if (nodes.length === 0) {
    pushError(errors, "workflow", null, "workflow has no nodes");
  }

  // ── Node validation ────────────────────────────────────────────────
  const nodeIds = new Set();
  const triggerSubtypes = [];
  const planFeatures = new Set();
  const queues = new Set();
  let anyRequiresApproval = false;

  for (const node of nodes) {
    if (!node || !node.id) {
      pushError(errors, "node", null, "node is missing an id");
      continue;
    }
    if (nodeIds.has(node.id)) {
      pushError(errors, "node", node.id, "duplicate node id");
    }
    nodeIds.add(node.id);

    if (!node.type || !node.subtype) {
      pushError(errors, "node", node.id, "node is missing type or subtype");
      continue;
    }

    const entry = getRegistryEntry(node.subtype);
    if (!entry) {
      pushError(
        errors,
        "node",
        node.id,
        `unknown subtype "${node.subtype}" (not registered)`,
      );
      continue;
    }

    if (entry.type !== node.type) {
      pushError(
        errors,
        "node",
        node.id,
        `subtype "${node.subtype}" expects type "${entry.type}", got "${node.type}"`,
      );
    }

    const cfg = validateNodeConfig(node.subtype, node.config);
    if (!cfg.ok) {
      for (const message of cfg.errors) {
        pushError(errors, "node", node.id, `config: ${message}`);
      }
    }

    if (entry.type === "trigger") {
      triggerSubtypes.push(node.subtype);
    }

    if (entry.requiresApproval || node.requiresApproval) {
      anyRequiresApproval = true;
    }

    if (entry.planFeature) planFeatures.add(entry.planFeature);
    if (entry.queue) queues.add(entry.queue);

    if (entry.status === "preview") {
      pushWarning(
        warnings,
        "node",
        node.id,
        `subtype "${node.subtype}" is preview-only; engine will refuse execution until its processor is registered`,
      );
    }
    if (entry.status === "deprecated") {
      pushWarning(
        warnings,
        "node",
        node.id,
        `subtype "${node.subtype}" is deprecated`,
      );
    }
  }

  if (
    triggerSubtypes.length === 0 &&
    nodes.length > 0 &&
    errors.every((e) => e.scope !== "workflow")
  ) {
    pushError(errors, "workflow", null, "workflow has no trigger nodes");
  }

  // ── Edge validation ────────────────────────────────────────────────
  const edgeIds = new Set();
  for (const edge of edges) {
    if (!edge || !edge.id) {
      pushError(errors, "edge", null, "edge is missing an id");
      continue;
    }
    if (edgeIds.has(edge.id)) {
      pushError(errors, "edge", edge.id, "duplicate edge id");
    }
    edgeIds.add(edge.id);

    if (!edge.from || !nodeIds.has(edge.from)) {
      pushError(
        errors,
        "edge",
        edge.id,
        `edge.from references unknown node "${edge.from}"`,
      );
    }
    if (!edge.to || !nodeIds.has(edge.to)) {
      pushError(
        errors,
        "edge",
        edge.id,
        `edge.to references unknown node "${edge.to}"`,
      );
    }
    if (edge.from && edge.to && edge.from === edge.to) {
      pushError(errors, "edge", edge.id, "edge cannot self-loop");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      triggerSubtypes: Array.from(new Set(triggerSubtypes)),
      requiresApproval: anyRequiresApproval,
      planFeatures: Array.from(planFeatures).sort(),
      queues: Array.from(queues).sort(),
    },
  };
}
