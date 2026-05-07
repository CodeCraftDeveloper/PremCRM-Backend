import { UnrecoverableError } from "bullmq";

/**
 * NonRetryableError — throw from a processor when a failure should NOT be
 * retried (validation errors, permission errors, malformed payloads, deleted
 * tenants). BullMQ's UnrecoverableError sets `attemptsMade = attempts`
 * immediately so the worker `failed` event fires once and the job goes
 * straight to the failed set / DLQ audit.
 *
 * Use this instead of returning silently — the failure must be auditable.
 */
export class NonRetryableError extends UnrecoverableError {
  constructor(message, details = null) {
    super(message);
    this.name = "NonRetryableError";
    this.nonRetryable = true;
    if (details !== null) this.details = details;
  }
}

export { UnrecoverableError };

export const isNonRetryableError = (err) =>
  err instanceof UnrecoverableError || err?.nonRetryable === true;
