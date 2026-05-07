/**
 * Workflow v2 Orchestration Service — P3-003.
 *
 * Provides the core orchestration logic called by the BullMQ
 * `workflow.execute` processor. The orchestrator:
 *
 *  1. Loads (or creates) a WorkflowRun for a given WorkflowRun._id.
 *  2. Resolves the next node(s) from the graph (edges from currentNodeId).
 *  3. Dispatches each node to its registered executor (nodeExecutors.js).
 *  4. Records nodeRun results and updates WorkflowRun state.
 *  5. Recursively advances until no more outgoing edges remain.
 *  6. Marks the run as "succeeded" or "failed".
 *
 * Design constraints:
 *  - Preview-status subtypes cause immediate NonRetryableError.
 *  - Delay/approval nodes pause execution; the caller re-enqueues later.
 *  - Condition nodes with `passed: false` halt the branch (no failure).
 *  - The orchestrator is re-entrant: it reads current state from Mongo
 *    and advances from wherever `currentNodeId` left off.
 *  - Per-node idempotency: a nodeRun already in "succeeded" status is
 *    skipped on replay (BullMQ retry safety).
 */

import Workflow from "../../models/Workflow.js";
import WorkflowRun from "../../models/WorkflowRun.js";
import { compileWorkflow } from "./compileWorkflow.js";
import { getRegistryEntry } from "./actionRegistry.js";
import { getNodeExecutor } from "./nodeExecutors.js";
import { NonRetryableError } from "../../queue/errors.js";
import { incrementUsage } from "../usageMeterService.js";
import logger from "../../utils/logger.js";

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a map { nodeId → node } from the graph nodes array.
 */
function buildNodeMap(nodes) {
  const m = new Map();
  for (const n of nodes) m.set(n.id, n);
  return m;
}

/**
 * Build an adjacency list { fromId → [toId, …] } from the graph edges.
 */
function buildAdjacencyList(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  return adj;
}

/**
 * Find the nodeRun entry for a given nodeId, or create a stub.
 */
function findOrCreateNodeRun(run, node) {
  let nr = run.nodeRuns.find((r) => r.nodeId === node.id);
  if (!nr) {
    run.nodeRuns.push({
      nodeId: node.id,
      nodeType: node.type,
      nodeSubtype: node.subtype,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      input: null,
      output: null,
      error: { message: null, stack: null, nonRetryable: false },
      attemptsMade: 0,
      maxAttempts: 3,
    });
    nr = run.nodeRuns[run.nodeRuns.length - 1];
  }
  return nr;
}

// ── Core orchestration ──────────────────────────────────────────────────

/**
 * Execute a single node in the graph.
 *
 * Returns { input?, output?, waitUntil?, branchLabel?, waitingApproval? }
 */
async function executeNode(ctx) {
  const { node } = ctx;
  const entry = getRegistryEntry(node.subtype);

  if (!entry) {
    throw new NonRetryableError(
      `Unknown subtype "${node.subtype}" at node "${node.id}" — graph is corrupted or registry is out of sync.`,
    );
  }

  // Refuse preview-status nodes at runtime.
  if (entry.status === "preview") {
    throw new NonRetryableError(
      `Node "${node.id}" uses preview-only subtype "${node.subtype}". ` +
      `Enable this node type or remove it from the workflow before executing.`,
    );
  }

  // Refuse deprecated nodes at runtime.
  if (entry.status === "deprecated") {
    throw new NonRetryableError(
      `Node "${node.id}" uses deprecated subtype "${node.subtype}". ` +
      `Update the workflow to a supported action.`,
    );
  }

  // Trigger nodes don't need execution — they represent the entry point.
  if (entry.type === "trigger") {
    return { input: {}, output: { triggered: true } };
  }

  const executor = getNodeExecutor(node.subtype);
  if (!executor) {
    throw new NonRetryableError(
      `No executor registered for subtype "${node.subtype}". ` +
      `This node type is registered but not yet implemented.`,
    );
  }

  const result = await executor(ctx);
  return result;
}

/**
 * Advance the workflow run from the current node through the graph.
 *
 * This is the main orchestration loop. It:
 *  1. Picks the current node (from run.currentNodeId or the first trigger).
 *  2. Executes it.
 *  3. Records the result in the nodeRun.
 *  4. Follows outgoing edges to the next node(s).
 *  5. Repeats until the graph is exhausted or execution is paused.
 *
 * Returns the updated WorkflowRun document.
 */
export async function advanceRun(runId) {
  const run = await WorkflowRun.findById(runId);
  if (!run) {
    throw new NonRetryableError(`WorkflowRun "${runId}" not found.`);
  }

  // Already terminal — skip (idempotent replay).
  if (run.status === "succeeded" || run.status === "failed") {
    logger.info(`[WorkflowOrchestrator] Run ${runId} already ${run.status}, skipping.`);
    return run;
  }

  // Load the pinned workflow version.
  const workflow = await Workflow.findOne({
    _id: run.workflowId,
    tenantId: run.tenantId,
  });
  if (!workflow) {
    run.status = "failed";
    run.error = "Workflow definition not found.";
    run.finishedAt = new Date();
    await run.save();
    throw new NonRetryableError(
      `Workflow "${run.workflowId}" not found for tenant "${run.tenantId}".`,
    );
  }

  // Compile-check (catches any post-save mutations or stale graphs).
  const compiled = compileWorkflow(workflow);
  if (!compiled.ok) {
    run.status = "failed";
    run.error = `Compile errors: ${compiled.errors.map((e) => e.message).join("; ")}`;
    run.finishedAt = new Date();
    await run.save();
    throw new NonRetryableError(run.error);
  }

  const nodeMap = buildNodeMap(workflow.nodes);
  const adj = buildAdjacencyList(workflow.edges);

  // Find the starting point.
  let currentNodeId = run.currentNodeId;
  if (!currentNodeId) {
    // First execution: start at the first trigger node.
    const triggerNode = workflow.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) {
      run.status = "failed";
      run.error = "No trigger node found in workflow.";
      run.finishedAt = new Date();
      await run.save();
      throw new NonRetryableError(run.error);
    }
    currentNodeId = triggerNode.id;
  }

  // Mark run as running.
  if (run.status !== "running") {
    run.status = "running";
    run.startedAt = run.startedAt || new Date();
    await run.save();
  }

  // ── Walk the graph ────────────────────────────────────────────────
  const visited = new Set();
  const MAX_NODES = 200; // Safety limit to prevent infinite loops.

  async function walkNode(nodeId) {
    if (visited.size >= MAX_NODES) {
      throw new NonRetryableError(
        `Workflow execution exceeded ${MAX_NODES} node limit. Possible cycle in graph.`,
      );
    }

    if (visited.has(nodeId)) return; // Already processed in this walk.
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      logger.warn(`[WorkflowOrchestrator] Node "${nodeId}" not in graph; skipping.`);
      return;
    }

    // Update pointer.
    run.currentNodeId = nodeId;

    // Find or create the nodeRun sub-doc.
    const nr = findOrCreateNodeRun(run, node);

    // Idempotency: already succeeded → skip.
    if (nr.status === "succeeded") {
      // Still follow outgoing edges.
      const nextIds = adj.get(nodeId) || [];
      for (const nextId of nextIds) {
        await walkNode(nextId);
      }
      return;
    }

    // Mark running.
    nr.status = "running";
    nr.startedAt = nr.startedAt || new Date();
    nr.attemptsMade = (nr.attemptsMade || 0) + 1;
    await run.save();

    try {
      const ctx = {
        tenantId: run.tenantId.toString(),
        node,
        run,
        triggerSource: run.triggerSource,
        entity: run.triggerSource?.payload || null,
        user: null,
        nodeRun: nr,
      };

      const result = await executeNode(ctx);

      // Record result.
      nr.input = result.input || {};
      nr.output = result.output || {};

      // Check for condition short-circuit.
      if (node.type === "condition" && result.output?.passed === false) {
        nr.status = "skipped";
        nr.finishedAt = new Date();
        await run.save();
        // Do NOT follow outgoing edges — condition failed, branch stops.
        return;
      }

      // Check for delay.
      if (result.waitUntil) {
        nr.status = "delayed";
        nr.waitUntil = result.waitUntil;
        await run.save();
        // Execution pauses. The delay scheduler re-enqueues later.
        // Update run status to waiting.
        run.status = "waiting";
        await run.save();
        return;
      }

      // Check for approval hold.
      if (result.waitingApproval) {
        nr.status = "waiting_approval";
        await run.save();
        // Execution pauses. The approval callback re-enqueues later.
        run.status = "waiting";
        await run.save();
        return;
      }

      // Success.
      nr.status = "succeeded";
      nr.finishedAt = new Date();
      await run.save();

      // Follow outgoing edges.
      const nextIds = adj.get(nodeId) || [];
      for (const nextId of nextIds) {
        await walkNode(nextId);
      }
    } catch (err) {
      nr.status = "failed";
      nr.error = {
        message: (err.message || "Unknown error").slice(0, 4000),
        stack: (err.stack || "").slice(0, 8000),
        nonRetryable: err.nonRetryable === true || err instanceof NonRetryableError,
      };
      nr.finishedAt = new Date();

      // Propagate the failure to the run level.
      run.status = "failed";
      run.error = `Node "${nodeId}" (${node.subtype}) failed: ${nr.error.message}`;
      run.finishedAt = new Date();
      await run.save();

      throw err; // Re-throw so BullMQ records the failure.
    }
  }

  await walkNode(currentNodeId);

  // If we reached here without pausing, all reachable nodes are done.
  const reload = await WorkflowRun.findById(runId);
  if (
    reload.status === "running" &&
    !reload.nodeRuns.some(
      (nr) => nr.status === "delayed" || nr.status === "waiting_approval",
    )
  ) {
    reload.status = "succeeded";
    reload.finishedAt = new Date();
    await reload.save();
  }

  return reload;
}

// ── Run creation ────────────────────────────────────────────────────────

/**
 * Create a WorkflowRun and return it (does NOT start execution).
 *
 * @param {Object} opts
 * @param {string} opts.workflowId  — Workflow._id
 * @param {string} opts.tenantId    — tenant ObjectId
 * @param {Object} opts.triggerSource — { type, entityType?, entityId?, payload? }
 * @param {string} [opts.triggeredBy] — user ObjectId (optional)
 * @param {string} [opts.runKey]    — dedup key (optional)
 * @returns {WorkflowRun}
 */
export async function createRun({ workflowId, tenantId, triggerSource, triggeredBy, runKey }) {
  const workflow = await Workflow.findOne({ _id: workflowId, tenantId });
  if (!workflow) {
    throw new NonRetryableError(
      `Workflow "${workflowId}" not found for tenant "${tenantId}".`,
    );
  }

  if (!workflow.isActive) {
    throw new NonRetryableError(
      `Workflow "${workflowId}" is not active.`,
    );
  }

  // Compile-time validation.
  const compiled = compileWorkflow(workflow);
  if (!compiled.ok) {
    throw new NonRetryableError(
      `Workflow "${workflowId}" failed compilation: ${compiled.errors.map((e) => e.message).join("; ")}`,
    );
  }

  // Run-key dedup: if a run with the same runKey already exists, return it.
  if (runKey) {
    const existing = await WorkflowRun.findOne({ runKey, tenantId });
    if (existing) {
      logger.info(
        `[WorkflowOrchestrator] Dedup: existing run for runKey="${runKey}" → ${existing._id}`,
      );
      return existing;
    }
  }

  const run = await WorkflowRun.create({
    workflowId,
    tenantId,
    status: "pending",
    triggerSource: triggerSource || { type: "manual" },
    triggeredBy: triggeredBy || null,
    workflowVersion: workflow.version,
    workflowLineageId: workflow.lineageId || workflow._id,
    runKey: runKey || undefined,
    nodeRuns: [],
  });

  // Meter the run.
  try {
    await incrementUsage(tenantId, "workflowRuns", 1);
  } catch (meterErr) {
    // Best-effort — never block execution for metering.
    logger.warn(
      `[WorkflowOrchestrator] Usage meter increment failed for tenant ${tenantId}: ${meterErr.message}`,
    );
  }

  return run;
}
