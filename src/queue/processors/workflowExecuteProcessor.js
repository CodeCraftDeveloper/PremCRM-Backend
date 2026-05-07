/**
 * BullMQ processor for the `workflow.execute` queue — P3-003.
 *
 * Job payload shape:
 *   {
 *     tenantId: string  — required (enforced by enqueue() contract)
 *     workflowRunId: string — the WorkflowRun._id to advance
 *     workflowId: string — the Workflow._id (for creating a new run)
 *     triggerSource?: { type, entityType?, entityId?, payload? }
 *     triggeredBy?: string — user ObjectId
 *     runKey?: string — trigger-side dedup key
 *   }
 *
 * Two modes:
 *   1. **Resume mode** — `workflowRunId` is provided. The orchestrator
 *      resumes the existing run (e.g. after delay/approval callback).
 *   2. **Create+Run mode** — `workflowId` is provided. The orchestrator
 *      creates a new WorkflowRun, then advances it.
 *
 * The processor delegates entirely to the orchestrator service and
 * never catches NonRetryableErrors — those bubble to BullMQ so the
 * job fails permanently and the DLQ recorder picks it up.
 */

import { advanceRun, createRun } from "../../services/workflow/orchestrator.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

export async function processWorkflowExecute(job) {
  const { tenantId, workflowRunId, workflowId, triggerSource, triggeredBy, runKey } =
    job.data || {};

  if (!tenantId) {
    throw new NonRetryableError(
      `workflow.execute job ${job.id}: payload.tenantId is required.`,
    );
  }

  logger.info(
    `[WorkflowExecute] Job ${job.id} (attempt ${job.attemptsMade + 1}) ` +
    `tenant=${tenantId} runId=${workflowRunId || "(new)"} workflowId=${workflowId || "N/A"}`,
  );

  let runId = workflowRunId;

  // ── Create mode: build a new run, then advance ────────────────────
  if (!runId) {
    if (!workflowId) {
      throw new NonRetryableError(
        `workflow.execute job ${job.id}: either workflowRunId or workflowId is required.`,
      );
    }

    const run = await createRun({
      workflowId,
      tenantId,
      triggerSource,
      triggeredBy,
      runKey,
    });

    runId = run._id.toString();

    // Store the run ID back on the job data for observability.
    await job.updateData({ ...job.data, workflowRunId: runId });
  }

  // ── Advance the run ───────────────────────────────────────────────
  const result = await advanceRun(runId);

  logger.info(
    `[WorkflowExecute] Job ${job.id} finished. ` +
    `Run ${runId} status=${result.status} nodeRuns=${result.nodeRuns.length}`,
  );

  return {
    runId,
    status: result.status,
    nodeRunCount: result.nodeRuns.length,
    finishedAt: result.finishedAt?.toISOString() || null,
  };
}
