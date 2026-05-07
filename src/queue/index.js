import {
  getQueue,
  getAllQueues,
  closeAllQueues,
  listKnownQueues,
  BULLMQ_PREFIX,
  DEFAULT_JOB_OPTIONS,
} from "./registry.js";
import {
  getBullConnection,
  closeBullConnection,
  isBullConnectionEnabled,
} from "./connection.js";
import { QUEUE_NAMES, QUEUE_NAME_LIST, isKnownQueueName } from "./queueNames.js";
import {
  NonRetryableError,
  UnrecoverableError,
  isNonRetryableError,
} from "./errors.js";
import { RETRY_POLICIES, getRetryPolicy } from "./retryPolicies.js";
import logger from "../utils/logger.js";

export {
  QUEUE_NAMES,
  QUEUE_NAME_LIST,
  isKnownQueueName,
  getQueue,
  getAllQueues,
  listKnownQueues,
  BULLMQ_PREFIX,
  DEFAULT_JOB_OPTIONS,
  getBullConnection,
  isBullConnectionEnabled,
  NonRetryableError,
  UnrecoverableError,
  isNonRetryableError,
  RETRY_POLICIES,
  getRetryPolicy,
};

/**
 * Eagerly construct queue instances at startup so connection failures surface
 * immediately rather than on first enqueue. Safe to call when REDIS_URL is
 * unset — degrades to a no-op with a warning.
 */
export function initQueues() {
  if (!isBullConnectionEnabled()) {
    logger.warn(
      "BullMQ initQueues skipped — REDIS_URL not set. Queue-backed features will be no-ops.",
    );
    return 0;
  }
  let count = 0;
  for (const name of QUEUE_NAME_LIST) {
    if (getQueue(name)) count += 1;
  }
  logger.info(`BullMQ queues initialized: ${count} of ${QUEUE_NAME_LIST.length}`);
  return count;
}

/**
 * Enqueue a job onto a known queue.
 *
 * Tenant isolation contract: every job payload MUST include `tenantId`.
 * This is enforced here because workers re-validate tenant status before
 * acting on the job (see `IMPLEMENTATION_CONTRACT.md` §2 + §4).
 *
 * Idempotency: pass `options.idempotencyKey` for outbound/replay-sensitive
 * work. BullMQ deduplicates by `jobId`, so the same key cannot be enqueued
 * twice while the prior job is still resident in Redis.
 *
 * Returns null when the queue layer is disabled (no REDIS_URL). Callers
 * should treat null as "queue unavailable" and fall back / fail closed
 * depending on the feature.
 */
export async function enqueue(queueName, jobName, payload, options = {}) {
  if (!isKnownQueueName(queueName)) {
    throw new Error(`enqueue: unknown queue name "${queueName}"`);
  }
  if (!jobName || typeof jobName !== "string") {
    throw new Error(`enqueue: jobName is required (queue ${queueName})`);
  }
  if (!payload || typeof payload !== "object" || !payload.tenantId) {
    throw new Error(
      `enqueue: payload.tenantId is required (queue ${queueName}, job ${jobName})`,
    );
  }

  const queue = getQueue(queueName);
  if (!queue) return null;

  const { idempotencyKey, ...rest } = options;
  const jobOptions = { ...rest };
  if (idempotencyKey) jobOptions.jobId = String(idempotencyKey);

  return queue.add(jobName, payload, jobOptions);
}

export async function closeQueues() {
  await closeAllQueues();
  await closeBullConnection();
}
