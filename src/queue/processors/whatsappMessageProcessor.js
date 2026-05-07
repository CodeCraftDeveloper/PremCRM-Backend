import { NonRetryableError } from "../errors.js";
import { WhatsappMessageSyncService } from "../../services/whatsappMessageSyncService.js";
import {
  WHATSAPP_SEND_JOB_NAME,
} from "../../services/whatsappOutboundService.js";
import { processWhatsappSend } from "./whatsappSendProcessor.js";

/**
 * Processor for the `whatsapp.messages` queue.
 *
 * Job payload contract:
 *   {
 *     tenantId: string,
 *     integrationEventId: string,
 *     channelAccountId: string,
 *     kind: "message" | "status"
 *   }
 */
export async function processWhatsappMessage(job) {
  if (job?.name === WHATSAPP_SEND_JOB_NAME) {
    return processWhatsappSend(job);
  }

  const data = job.data || {};
  if (!data.tenantId) {
    throw new NonRetryableError(
      `whatsapp.messages job ${job.id}: payload.tenantId is required.`,
    );
  }
  if (!data.integrationEventId) {
    throw new NonRetryableError(
      `whatsapp.messages job ${job.id}: payload.integrationEventId is required.`,
    );
  }

  try {
    return await WhatsappMessageSyncService.processWhatsappIntegrationEvent({
      tenantId: data.tenantId,
      integrationEventId: data.integrationEventId,
    });
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      throw new NonRetryableError(
        `whatsapp.messages job ${job.id}: ${err.message}`,
      );
    }
    throw err;
  }
}
