import {
  WhatsappMediaService,
  WhatsappMediaPermanentError,
} from "../../services/whatsappMediaService.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

/**
 * Processor for `whatsapp.media.download` jobs on the
 * `whatsapp.messages` queue. Routed from `whatsappMessageProcessor.js`.
 */
export async function processWhatsappMediaDownload(job) {
  const data = job?.data || {};
  const { tenantId, messageId, attachmentIndex } = data;

  if (!tenantId) {
    throw new NonRetryableError(
      `whatsapp.messages/${job?.name} job ${job?.id}: tenantId is required.`,
    );
  }
  if (!messageId) {
    throw new NonRetryableError(
      `whatsapp.messages/${job?.name} job ${job?.id}: messageId is required.`,
    );
  }

  try {
    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId,
      messageId,
      attachmentIndex: Number.isFinite(attachmentIndex) ? attachmentIndex : 0,
    });
    if (result?.skipped) {
      logger.info(
        `[WhatsappMedia] job ${job.id} skipped (${result.reason}) for message ${messageId}.`,
      );
    } else {
      logger.info(
        `[WhatsappMedia] job ${job.id} downloaded ${result.storageKey} (${result.sizeBytes} bytes).`,
      );
    }
    return result;
  } catch (err) {
    if (err instanceof WhatsappMediaPermanentError) {
      throw new NonRetryableError(
        `whatsapp.messages/${job.name} job ${job.id}: permanent failure (HTTP ${err.status}): ${err.message}`,
      );
    }
    throw err;
  }
}
