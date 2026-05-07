/**
 * CRM Event Bus — P3-004.
 *
 * Central dispatcher that bridges CRM entity mutations (create / update /
 * stage change / field change) to both the legacy v1 WorkflowEngine AND
 * the new Workflow v2 execution pipeline.
 *
 * When a CRM entity is created, updated, or stage-changed, the controller
 * calls `emitCrmEvent(ctx)`. This function:
 *
 *   1. Fires the v1 `WorkflowEngine.fire()` for backward compatibility
 *      (AutomationRule matching + in-process execution).
 *   2. Queries the Workflow collection for active v2 workflows whose
 *      `triggerSubtypes` include the matching subtype
 *      (e.g. `trigger.deal.on_create`).
 *   3. For each matched workflow, creates a WorkflowRun via the
 *      orchestrator, then enqueues a `workflow.execute` BullMQ job.
 *
 * This dual-fire approach lets v1 and v2 coexist during the migration
 * period. When v1 is retired (post-Phase 3), the v1 fire call becomes
 * a no-op and can be removed.
 *
 * Design decisions:
 *  - Non-blocking: the event bus is fire-and-forget. Errors in v2 trigger
 *    matching / enqueue are caught and logged — they never block the API
 *    response.
 *  - Tenant-scoped: only workflows belonging to the same tenant are matched.
 *  - Run-key dedup: singleton workflows use a composite run key of
 *    `${workflowId}:${entityType}:${entityId}` so the same entity event
 *    doesn't create duplicate runs while one is in-flight.
 *  - Trigger payload: the entity snapshot and change context are passed
 *    through `triggerSource.payload` so the orchestrator and node
 *    executors can read the full entity at execution time.
 */

import Workflow from "../../models/Workflow.js";
import WorkflowEngine from "../../core/crm/WorkflowEngine.js";
import { enqueue, QUEUE_NAMES, isBullConnectionEnabled } from "../../queue/index.js";
import { createRun } from "./orchestrator.js";
import logger from "../../utils/logger.js";

// ── V1 module ↔ trigger event to v2 subtype mapping ────────────────────

const VALID_MODULES = new Set([
  "lead",
  "contact",
  "account",
  "deal",
  "activity",
]);

const VALID_TRIGGER_TYPES = new Set([
  "on_create",
  "on_update",
  "on_stage_change",
  "on_field_change",
  "time_based",
]);

/**
 * Convert a CRM event context to the v2 trigger subtype.
 *
 * @param {string} module  — "lead" | "contact" | "account" | "deal" | "activity"
 * @param {string} triggerType — "on_create" | "on_update" | "on_stage_change" | etc.
 * @returns {string|null} — e.g. "trigger.deal.on_create" or null if invalid
 */
export function buildTriggerSubtype(module, triggerType) {
  if (!VALID_MODULES.has(module)) return null;
  if (!VALID_TRIGGER_TYPES.has(triggerType)) return null;
  return `trigger.${module}.${triggerType}`;
}

/**
 * Build a dedup run key for singleton workflows.
 *
 * @param {string} workflowId
 * @param {string} entityType
 * @param {string} entityId
 * @returns {string}
 */
function buildRunKey(workflowId, entityType, entityId) {
  return `${workflowId}:${entityType}:${entityId || "none"}`;
}

// ── Core event emitter ─────────────────────────────────────────────────

/**
 * Emit a CRM event to both v1 and v2 workflow engines.
 *
 * @param {Object}  ctx
 * @param {string}  ctx.tenantId       — tenant ObjectId string
 * @param {string}  ctx.module         — "lead" | "contact" | "account" | "deal" | "activity"
 * @param {string}  ctx.triggerType    — "on_create" | "on_update" | "on_stage_change" | "on_field_change"
 * @param {Object}  ctx.entity         — the current entity document (plain object)
 * @param {Object}  [ctx.changes]      — { field: { old, new } } for update/field_change triggers
 * @param {Object}  [ctx.user]         — acting user
 *
 * Non-blocking. Errors are caught and logged — never propagated to the caller.
 */
export function emitCrmEvent(ctx) {
  // Defer to next tick so it never blocks the API response.
  setImmediate(() => {
    _processEvent(ctx).catch((err) => {
      logger.error("[CrmEventBus] Unhandled error in event processing:", err.message);
    });
  });
}

/**
 * Internal processing — fire v1, then match and enqueue v2 workflows.
 */
async function _processEvent(ctx) {
  const { tenantId, module, triggerType, entity, changes, user } = ctx;

  // ── 1. Fire v1 engine (backward compat) ───────────────────────────
  try {
    await WorkflowEngine._process({
      tenantId,
      module,
      triggerType,
      entity,
      changes: changes || {},
      user,
    });
  } catch (v1Err) {
    logger.error(
      `[CrmEventBus] v1 WorkflowEngine error for ${module}.${triggerType}: ${v1Err.message}`,
    );
  }

  // ── 2. Match v2 workflows ─────────────────────────────────────────
  const subtype = buildTriggerSubtype(module, triggerType);
  if (!subtype) {
    logger.warn(
      `[CrmEventBus] Unrecognized module/triggerType: ${module}/${triggerType}`,
    );
    return;
  }

  let matchedWorkflows;
  try {
    matchedWorkflows = await Workflow.find({
      tenantId,
      triggerSubtypes: subtype,
      status: "active",
      isActive: true,
      deletedAt: null,
    })
      .select("_id singleton")
      .lean();
  } catch (queryErr) {
    logger.error(
      `[CrmEventBus] v2 workflow query failed for ${subtype}: ${queryErr.message}`,
    );
    return;
  }

  if (!matchedWorkflows || matchedWorkflows.length === 0) {
    return; // No v2 workflows — done.
  }

  logger.info(
    `[CrmEventBus] ${subtype}: matched ${matchedWorkflows.length} v2 workflow(s) for tenant ${tenantId}`,
  );

  // ── 3. Create runs and enqueue ────────────────────────────────────
  const entityId = entity?._id?.toString?.() || entity?._id || null;

  const triggerSource = {
    type: triggerType,
    entityType: module,
    entityId: entityId || undefined,
    payload: {
      ...(entity || {}),
      _changes: changes || undefined,
    },
  };

  for (const wf of matchedWorkflows) {
    try {
      const runKey = wf.singleton
        ? buildRunKey(wf._id.toString(), module, entityId)
        : undefined;

      const run = await createRun({
        workflowId: wf._id.toString(),
        tenantId: tenantId.toString(),
        triggerSource,
        triggeredBy: user?._id?.toString?.() || user?._id || undefined,
        runKey,
      });

      // Enqueue for BullMQ processing.
      const job = await enqueue(
        QUEUE_NAMES.WORKFLOW_EXECUTE,
        `v2.${subtype}`,
        {
          tenantId: tenantId.toString(),
          workflowRunId: run._id.toString(),
        },
        runKey ? { idempotencyKey: `run:${run._id}` } : {},
      );

      if (job) {
        logger.info(
          `[CrmEventBus] Enqueued workflow.execute job ${job.id} ` +
          `for workflow ${wf._id} run ${run._id}`,
        );
      } else {
        // Queue unavailable (no Redis). Run created in Mongo but won't
        // execute until a worker picks it up or an admin replays it.
        logger.warn(
          `[CrmEventBus] Queue unavailable — run ${run._id} created but not enqueued.`,
        );
      }
    } catch (runErr) {
      // Per-workflow error isolation: one workflow's failure doesn't
      // block others from firing.
      logger.error(
        `[CrmEventBus] Failed to create/enqueue run for workflow ${wf._id}: ${runErr.message}`,
      );
    }
  }
}

/**
 * Synchronous version of the v2 trigger-match + enqueue flow.
 * Useful for testing and manual invocations where the caller
 * needs to await completion.
 *
 * Returns an array of { workflowId, runId, jobId? } results.
 */
export async function emitCrmEventSync(ctx) {
  const { tenantId, module, triggerType, entity, changes, user } = ctx;
  const results = [];

  // v1 fire (sync)
  try {
    await WorkflowEngine._process({
      tenantId,
      module,
      triggerType,
      entity,
      changes: changes || {},
      user,
    });
  } catch (v1Err) {
    logger.error(
      `[CrmEventBus] v1 WorkflowEngine error: ${v1Err.message}`,
    );
  }

  // v2 match
  const subtype = buildTriggerSubtype(module, triggerType);
  if (!subtype) return results;

  const matchedWorkflows = await Workflow.find({
    tenantId,
    triggerSubtypes: subtype,
    status: "active",
    isActive: true,
    deletedAt: null,
  })
    .select("_id singleton")
    .lean();

  if (!matchedWorkflows || matchedWorkflows.length === 0) return results;

  const entityId = entity?._id?.toString?.() || entity?._id || null;

  const triggerSource = {
    type: triggerType,
    entityType: module,
    entityId: entityId || undefined,
    payload: {
      ...(entity || {}),
      _changes: changes || undefined,
    },
  };

  for (const wf of matchedWorkflows) {
    try {
      const runKey = wf.singleton
        ? buildRunKey(wf._id.toString(), module, entityId)
        : undefined;

      const run = await createRun({
        workflowId: wf._id.toString(),
        tenantId: tenantId.toString(),
        triggerSource,
        triggeredBy: user?._id?.toString?.() || user?._id || undefined,
        runKey,
      });

      let jobId = null;
      if (isBullConnectionEnabled()) {
        const job = await enqueue(
          QUEUE_NAMES.WORKFLOW_EXECUTE,
          `v2.${subtype}`,
          {
            tenantId: tenantId.toString(),
            workflowRunId: run._id.toString(),
          },
          runKey ? { idempotencyKey: `run:${run._id}` } : {},
        );
        jobId = job?.id || null;
      }

      results.push({
        workflowId: wf._id.toString(),
        runId: run._id.toString(),
        jobId,
      });
    } catch (runErr) {
      logger.error(
        `[CrmEventBus] Sync: failed for workflow ${wf._id}: ${runErr.message}`,
      );
      results.push({
        workflowId: wf._id.toString(),
        runId: null,
        error: runErr.message,
      });
    }
  }

  return results;
}

export const __TEST_ONLY__ = Object.freeze({
  VALID_MODULES,
  VALID_TRIGGER_TYPES,
  buildRunKey,
});
