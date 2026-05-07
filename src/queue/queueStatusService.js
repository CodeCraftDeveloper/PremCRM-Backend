import FailedJob from "../models/FailedJob.js";
import { getQueue, getResolvedJobOptions } from "./registry.js";
import { isBullConnectionEnabled } from "./connection.js";
import { QUEUE_NAME_LIST } from "./queueNames.js";
import logger from "../utils/logger.js";

/**
 * Per-queue counts as exposed by BullMQ's `getJobCounts`. Returns a stable
 * shape per queue so the admin UI can render a fixed table even when some
 * queues haven't been instantiated yet.
 *
 * Returns `{ enabled: false, queues: [] }` when the Redis-backed queue layer
 * is disabled (no REDIS_URL). The endpoint stays reachable so operators can
 * see the queue layer is intentionally off rather than misconfigured.
 */
export async function getQueueCounts() {
  if (!isBullConnectionEnabled()) {
    return {
      enabled: false,
      queues: QUEUE_NAME_LIST.map((name) => ({
        name,
        attempts: getResolvedJobOptions(name).attempts ?? null,
        counts: null,
        error: "redis-disabled",
      })),
    };
  }

  const results = await Promise.all(
    QUEUE_NAME_LIST.map(async (name) => {
      const opts = getResolvedJobOptions(name);
      const baseRow = {
        name,
        attempts: opts.attempts ?? null,
        counts: null,
        error: null,
      };

      let queue;
      try {
        queue = getQueue(name);
      } catch (err) {
        return { ...baseRow, error: err.message };
      }
      if (!queue) return { ...baseRow, error: "queue-unavailable" };

      try {
        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
          "paused",
        );
        return { ...baseRow, counts };
      } catch (err) {
        logger.error(`getJobCounts failed for ${name}: ${err.message}`);
        return { ...baseRow, error: err.message };
      }
    }),
  );

  return { enabled: true, queues: results };
}

/**
 * Read the FailedJob audit collection.
 *
 * Tenant scope is enforced by the caller (controller). When `tenantId` is
 * provided, results are restricted to that tenant. `queueName` and `status`
 * are optional filters. `limit` is hard-capped at 200 to keep responses bounded.
 */
export async function getRecentFailedJobs({
  tenantId = null,
  queueName = null,
  status = null,
  limit = 50,
} = {}) {
  const filter = {};
  if (tenantId) filter.tenantId = String(tenantId);
  if (queueName) filter.queueName = queueName;
  if (status) filter.status = status;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const docs = await FailedJob.find(filter)
    .sort({ failedAt: -1 })
    .limit(safeLimit)
    .lean();

  return docs.map((d) => ({
    id: String(d._id),
    tenantId: d.tenantId,
    queueName: d.queueName,
    jobName: d.jobName,
    jobId: d.jobId,
    attemptsMade: d.attemptsMade,
    maxAttempts: d.maxAttempts,
    failedReason: d.failedReason,
    nonRetryable: d.nonRetryable,
    status: d.status,
    failedAt: d.failedAt,
    replayedAt: d.replayedAt,
    resolvedAt: d.resolvedAt,
  }));
}
