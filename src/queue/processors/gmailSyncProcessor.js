import {
  GMAIL_WATCH_RENEWAL_JOB_NAME,
  processWatchRenewalScan,
} from "../schedulers/gmailWatchRenewalScheduler.js";
import { processGmailSend } from "./gmailSendProcessor.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

export const GMAIL_SEND_JOB_NAME = "message.send";

/**
 * Top-level processor for the `gmail.sync` queue.
 *
 * Routing:
 *   - `watch.renewal-scan` (P5-002) → run the watch renewal pass
 *   - `message.send` (P5-004)       → send an approved outbound Gmail message
 */
export async function processGmailSync(job) {
  const name = job?.name;

  if (name === GMAIL_WATCH_RENEWAL_JOB_NAME) {
    const result = await processWatchRenewalScan();
    logger.info(
      `[GmailSync] watch.renewal-scan complete — scanned=${result.scanned} renewed=${result.renewed} failures=${result.failures.length}`,
    );
    return result;
  }

  if (name === GMAIL_SEND_JOB_NAME) {
    return processGmailSend(job);
  }

  throw new NonRetryableError(
    `gmail.sync: unknown job name "${name}". Register a handler before enqueueing.`,
  );
}
