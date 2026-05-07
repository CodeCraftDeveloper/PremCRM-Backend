import { getQueue } from "../registry.js";
import { QUEUE_NAMES, isKnownQueueName } from "../queueNames.js";
import { GmailWatchService } from "../../services/gmailWatchService.js";
import logger from "../../utils/logger.js";

const REPEAT_JOB_NAME = "watch.renewal-scan";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Scheduler for Gmail watch renewals.
 *
 * Registers a BullMQ repeatable job on the `gmail.sync` queue. On every
 * tick the worker calls `GmailWatchService.runRenewalPass()` which finds
 * accounts whose Pub/Sub watch is missing or expiring within 24h and
 * re-issues `users.watch`.
 *
 * The scheduler is bootstrapped from the worker process (worker.js) only
 * when REDIS_URL is configured. On Redis-less local development it is
 * a no-op.
 */
export async function scheduleGmailWatchRenewals({
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!isKnownQueueName(QUEUE_NAMES.GMAIL_SYNC)) return null;

  const queue = getQueue(QUEUE_NAMES.GMAIL_SYNC);
  if (!queue) {
    logger.warn(
      "scheduleGmailWatchRenewals skipped — gmail.sync queue unavailable (Redis disabled?).",
    );
    return null;
  }

  await queue.add(
    REPEAT_JOB_NAME,
    { tenantId: "system", scheduler: "gmail-watch-renewal" },
    {
      repeat: { every: intervalMs },
      jobId: "gmail-watch-renewal-scan",
      removeOnComplete: { age: 60 * 60, count: 50 },
      removeOnFail: { age: 24 * 60 * 60 },
    },
  );

  logger.info(
    `Gmail watch renewal scheduler registered (every ${Math.round(
      intervalMs / 1000 / 60,
    )} min)`,
  );
  return { intervalMs, jobName: REPEAT_JOB_NAME };
}

/**
 * Processor entry for repeated `gmail.sync` watch-renewal jobs.
 * The worker registers a single processor for `gmail.sync`; that
 * processor delegates renewal-scan jobs here and lets future
 * gmail.sync.* job names route to dedicated handlers as they land.
 */
export async function processWatchRenewalScan() {
  return GmailWatchService.runRenewalPass();
}

export const GMAIL_WATCH_RENEWAL_JOB_NAME = REPEAT_JOB_NAME;
export const GMAIL_WATCH_RENEWAL_DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
