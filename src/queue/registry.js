import { Queue } from "bullmq";
import { getBullConnection } from "./connection.js";
import { QUEUE_NAME_LIST, isKnownQueueName } from "./queueNames.js";
import { getRetryPolicy } from "./retryPolicies.js";
import logger from "../utils/logger.js";

const queues = new Map();

export const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || "orbinest";

/**
 * Default job options applied to every queue.
 *
 * - `attempts: 5` covers transient provider/network errors.
 * - Exponential backoff starting at 1s, capped indirectly by `attempts`.
 * - Successful jobs retained 1h or last 1000 (whichever first) for triage.
 * - Failed jobs retained 7 days so DLQ tooling can inspect them.
 *
 * Per-queue overrides (rate-limit aware retries, no-retry validation errors)
 * belong on the individual processor when each queue lands.
 */
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
});

export function getQueue(name) {
  if (!isKnownQueueName(name)) {
    throw new Error(`Unknown queue name: ${name}`);
  }
  if (queues.has(name)) return queues.get(name);

  const connection = getBullConnection();
  if (!connection) {
    logger.warn(
      `BullMQ disabled (REDIS_URL not set); queue "${name}" unavailable`,
    );
    return null;
  }

  const queue = new Queue(name, {
    connection,
    prefix: BULLMQ_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...getRetryPolicy(name) },
  });
  queues.set(name, queue);
  return queue;
}

export function getResolvedJobOptions(name) {
  return { ...DEFAULT_JOB_OPTIONS, ...getRetryPolicy(name) };
}

export function getAllQueues() {
  return Array.from(queues.values());
}

export async function closeAllQueues() {
  const entries = Array.from(queues.entries());
  queues.clear();
  for (const [name, q] of entries) {
    try {
      await q.close();
    } catch (err) {
      logger.error(`Error closing queue ${name}: ${err.message}`);
    }
  }
}

export function listKnownQueues() {
  return [...QUEUE_NAME_LIST];
}
