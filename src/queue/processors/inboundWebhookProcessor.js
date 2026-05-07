import IntegrationEvent from "../../models/IntegrationEvent.js";
import { NonRetryableError } from "../errors.js";
import { syncFromHistoryId } from "../../services/gmailSyncService.js";
import logger from "../../utils/logger.js";

/**
 * Processor for the `inbound.webhooks` queue.
 *
 * Job payload contract:
 *   {
 *     tenantId:           string  — required (enqueue() enforces)
 *     provider:           string  — gmail | whatsapp | meta | gmb
 *     integrationEventId: string  — IntegrationEvent._id
 *     channelAccountId?:  string
 *     emailAddress?:      string  (gmail)
 *     historyId?:         string  (gmail)
 *   }
 *
 * Behaviour:
 *   - `provider==="gmail"`: run a real history-list sync for the
 *     ChannelAccount (P5-003). On success the event is marked
 *     "processed" and the ChannelAccount's `syncCursor` is advanced.
 *   - Other providers: foundation placeholder until their slices land.
 *   - Validation failures (missing tenant, missing event, etc.) throw
 *     `NonRetryableError` so the DLQ records them on attempt 1.
 *   - Transient sync failures throw a regular Error so BullMQ honours
 *     the queue's retry policy (P2-002 → 8 attempts for inbound.webhooks).
 */
export async function processInboundWebhook(job) {
  const data = job.data || {};
  const { tenantId, provider, integrationEventId } = data;

  if (!tenantId) {
    throw new NonRetryableError(
      `inbound.webhooks job ${job.id}: payload.tenantId is required.`,
    );
  }
  if (!provider) {
    throw new NonRetryableError(
      `inbound.webhooks job ${job.id}: payload.provider is required.`,
    );
  }
  if (!integrationEventId) {
    throw new NonRetryableError(
      `inbound.webhooks job ${job.id}: payload.integrationEventId is required.`,
    );
  }

  const event = await IntegrationEvent.findOne({
    _id: integrationEventId,
    tenantId,
    provider,
  });

  if (!event) {
    throw new NonRetryableError(
      `inbound.webhooks job ${job.id}: IntegrationEvent ${integrationEventId} not found for tenant ${tenantId}.`,
    );
  }

  if (event.status === "processed") {
    logger.info(
      `[InboundWebhook] Job ${job.id} skipped — event ${event._id} already processed.`,
    );
    return { skipped: true, eventId: String(event._id) };
  }

  if (provider === "gmail") {
    const channelAccountId =
      data.channelAccountId || (event.channelAccountId
        ? String(event.channelAccountId)
        : null);
    if (!channelAccountId) {
      throw new NonRetryableError(
        `inbound.webhooks job ${job.id}: gmail event ${event._id} has no channelAccountId.`,
      );
    }

    const syncResult = await syncFromHistoryId({
      tenantId,
      channelAccountId,
      fallbackHistoryId: data.historyId || null,
    });

    event.status = "processed";
    event.processedAt = new Date();
    event.statusReason = syncResult?.reason || null;
    await event.save();

    logger.info(
      `[InboundWebhook] Job ${job.id} processed gmail event ${event._id} ` +
        `(scanned=${syncResult?.scanned ?? 0} imported=${syncResult?.imported ?? 0} ` +
        `bootstrapped=${syncResult?.bootstrapped ?? false}).`,
    );

    return {
      eventId: String(event._id),
      provider: "gmail",
      ...syncResult,
    };
  }

  event.status = "processed";
  event.processedAt = new Date();
  await event.save();

  logger.info(
    `[InboundWebhook] Job ${job.id} processed event ${event._id} (provider=${provider}). ` +
      `Provider sync handler not yet registered — placeholder ack only.`,
  );

  return {
    eventId: String(event._id),
    provider,
    pendingSync: false,
  };
}
