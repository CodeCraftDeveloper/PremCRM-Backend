import {
  GmailOutboundService,
  GmailSendPermanentError,
} from "../../services/gmailOutboundService.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

/**
 * Processor for the `gmail.sync` queue / `message.send` job.
 *
 * Job payload contract:
 *   {
 *     tenantId:          string  — required (enqueue() enforces)
 *     messageId:         string  — required, the outbound Message._id
 *     channelAccountId?: string  — informational; service re-resolves
 *   }
 *
 * Idempotency: the service re-checks `Message.status` and skips if the
 * message has already advanced past `pending`.  The BullMQ `jobId` is
 * the message idempotency key so duplicate enqueues collapse while
 * the job is resident.
 *
 * Failure handling:
 *   - Missing payload fields → NonRetryableError (DLQ on attempt 1).
 *   - Gmail 4xx (invalid recipient, quota policy, bad request) → the
 *     service throws GmailSendPermanentError; the processor converts to
 *     NonRetryableError so the DLQ records it without 8 wasted retries.
 *   - Gmail 429/5xx → the service throws GmailSendTransientError; the
 *     processor lets it bubble so BullMQ's 8-attempt policy applies.
 */
export async function processGmailSend(job) {
  const data = job?.data || {};
  const { tenantId, messageId } = data;

  if (!tenantId) {
    throw new NonRetryableError(
      `gmail.sync/message.send job ${job.id}: tenantId is required.`,
    );
  }
  if (!messageId) {
    throw new NonRetryableError(
      `gmail.sync/message.send job ${job.id}: messageId is required.`,
    );
  }

  try {
    const result = await GmailOutboundService.sendApprovedMessage({
      tenantId,
      messageId,
    });
    logger.info(
      `[GmailSend] job ${job.id} sent message ${messageId} ` +
        `(providerMessageId=${result?.providerMessageId || "skipped"}).`,
    );
    return result;
  } catch (err) {
    if (err instanceof GmailSendPermanentError) {
      throw new NonRetryableError(
        `gmail.sync/message.send job ${job.id}: permanent failure (HTTP ${err.status}): ${err.message}`,
      );
    }
    throw err;
  }
}
