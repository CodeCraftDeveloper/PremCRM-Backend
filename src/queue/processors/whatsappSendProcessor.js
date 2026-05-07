import {
  WhatsappOutboundService,
  WhatsappSendPermanentError,
} from "../../services/whatsappOutboundService.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

export async function processWhatsappSend(job) {
  const data = job?.data || {};
  const { tenantId, messageId } = data;

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
    const result = await WhatsappOutboundService.sendApprovedMessage({
      tenantId,
      messageId,
    });
    logger.info(
      `[WhatsappSend] job ${job.id} sent message ${messageId} ` +
        `(providerMessageId=${result?.providerMessageId || "skipped"}).`,
    );
    return result;
  } catch (err) {
    if (err instanceof WhatsappSendPermanentError) {
      throw new NonRetryableError(
        `whatsapp.messages/${job.name} job ${job.id}: permanent failure (HTTP ${err.status}): ${err.message}`,
      );
    }
    throw err;
  }
}
