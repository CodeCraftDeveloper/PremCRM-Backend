import mongoose from "mongoose";
import FailedJob from "../models/FailedJob.js";
import { isNonRetryableError } from "./errors.js";
import logger from "../utils/logger.js";

/**
 * Decide whether a worker `failed` event represents a terminal failure
 * (no further retries will happen).
 *
 * BullMQ fires `failed` after every failed attempt. Terminal failure means
 * EITHER attempts are exhausted OR the error was thrown as a non-retryable
 * (UnrecoverableError / NonRetryableError) which BullMQ treats as immediate
 * exhaustion (it sets `attemptsMade = attempts`).
 */
export function isTerminalFailure(job, err) {
  if (!job) return false;
  if (isNonRetryableError(err)) return true;
  const max = job.opts?.attempts ?? 1;
  const made = job.attemptsMade ?? 0;
  return made >= max;
}

/**
 * Record a terminally-failed job in the FailedJob audit collection.
 *
 * Best-effort: any storage failure is logged but never thrown — recording
 * the audit log must NEVER cause additional worker churn or surface as a
 * second failure event.
 *
 * Returns the saved document or null if recording was skipped/failed.
 */
export async function recordFailedJob({ queueName, job, err }) {
  try {
    if (!job) return null;
    if (mongoose.connection.readyState !== 1) {
      logger.warn(
        `recordFailedJob skipped — Mongo not connected (queue=${queueName}, job=${job?.id})`,
      );
      return null;
    }

    const tenantId = job.data?.tenantId;
    if (!tenantId) {
      logger.warn(
        `recordFailedJob skipped — payload.tenantId missing (queue=${queueName}, job=${job?.id})`,
      );
      return null;
    }

    const doc = await FailedJob.create({
      tenantId: String(tenantId),
      queueName,
      jobName: job.name || "unknown",
      jobId: String(job.id ?? ""),
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: job.opts?.attempts ?? 0,
      failedReason: (err?.message || "").slice(0, 2000),
      stackTrace: (err?.stack || "").slice(0, 8000),
      nonRetryable: isNonRetryableError(err),
      payload: job.data ?? {},
      failedAt: new Date(),
      status: "failed",
    });

    logger.error(
      `DLQ recorded: queue=${queueName} job=${doc.jobName}/${doc.jobId} tenant=${doc.tenantId} attempts=${doc.attemptsMade}/${doc.maxAttempts} reason="${doc.failedReason}"`,
    );
    return doc;
  } catch (recordErr) {
    logger.error(
      `recordFailedJob persistence error (queue=${queueName}, job=${job?.id}): ${recordErr.message}`,
    );
    return null;
  }
}
