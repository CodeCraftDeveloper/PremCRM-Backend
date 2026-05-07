import logger from "../../utils/logger.js";

/**
 * Smoke-test processor for the BullMQ foundation slice (P2-001).
 *
 * It validates that the queue/worker pipeline is end-to-end functional in a
 * given environment. Real domain processors (workflow.execute, ai.draft,
 * gmail.sync, etc.) replace this pattern in their respective phases.
 */
export async function processSmokeTest(job) {
  const { tenantId, message } = job.data || {};
  if (!tenantId) {
    throw new Error(
      `smoke.test job ${job.id} rejected: payload.tenantId is required`,
    );
  }
  logger.info(
    `smoke.test job ${job.id} (attempt ${job.attemptsMade + 1}) for tenant ${tenantId}: ${message ?? ""}`,
  );
  return {
    ok: true,
    tenantId,
    message: message ?? null,
    processedAt: new Date().toISOString(),
  };
}
