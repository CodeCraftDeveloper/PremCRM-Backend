import IntegrationEvent from "../models/IntegrationEvent.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import { enqueue, QUEUE_NAMES } from "../queue/index.js";
import logger from "../utils/logger.js";

/**
 * Decode Pub/Sub push body.
 *
 * Google Cloud Pub/Sub push delivery shape:
 *   {
 *     "message": {
 *       "data":        "<base64-encoded JSON payload>",
 *       "messageId":   "...",
 *       "publishTime": "..."
 *     },
 *     "subscription":  "projects/.../subscriptions/..."
 *   }
 *
 * For Gmail history notifications, the decoded `data` JSON looks like:
 *   { "emailAddress": "user@example.com", "historyId": "1234567890" }
 *
 * Returns null when the envelope cannot be parsed.
 */
export function decodePubsubEnvelope(body) {
  if (!body || typeof body !== "object" || !body.message) return null;
  const { message } = body;
  if (!message.messageId) return null;

  let parsedData = null;
  if (typeof message.data === "string" && message.data.length) {
    try {
      const json = Buffer.from(message.data, "base64").toString("utf8");
      parsedData = JSON.parse(json);
    } catch {
      parsedData = null;
    }
  }

  return {
    messageId: String(message.messageId),
    publishTime: message.publishTime || null,
    subscription: body.subscription || null,
    data: parsedData,
  };
}

/**
 * Persist + (when possible) enqueue an inbound Gmail Pub/Sub event.
 *
 * Behaviour:
 *   - Idempotent on (provider="gmail", externalEventId=messageId).
 *   - When the email address resolves to a known ChannelAccount, the
 *     IntegrationEvent is tagged with tenantId/channelAccountId and a
 *     job is added to `inbound.webhooks` carrying the event id forward.
 *   - When no ChannelAccount matches, the event is stored with
 *     status="skipped" so operators can still see what arrived.
 *
 * Always returns the IntegrationEvent (existing or newly written) so
 * the controller can shape the response.
 */
export async function ingestGmailPubsubEvent({
  envelope,
  signatureVerified,
  rawBody,
}) {
  if (!envelope || !envelope.messageId) {
    throw new Error("ingestGmailPubsubEvent: envelope.messageId required");
  }

  const existing = await IntegrationEvent.findOne({
    provider: "gmail",
    externalEventId: envelope.messageId,
  }).lean();
  if (existing) return { event: existing, deduplicated: true };

  const emailAddress =
    envelope.data?.emailAddress
      ? String(envelope.data.emailAddress).trim().toLowerCase()
      : null;
  const historyId = envelope.data?.historyId
    ? String(envelope.data.historyId)
    : null;

  let account = null;
  if (emailAddress) {
    account = await ChannelAccount.findOne({
      provider: "gmail",
      providerAccountId: emailAddress,
      deletedAt: null,
    })
      .select("_id tenantId")
      .lean();
  }

  const baseDoc = {
    provider: "gmail",
    eventType: "gmail.history",
    externalEventId: envelope.messageId,
    payload: {
      messageId: envelope.messageId,
      publishTime: envelope.publishTime,
      subscription: envelope.subscription,
      data: envelope.data,
      rawBody: rawBody || null,
    },
    signatureVerified: Boolean(signatureVerified),
  };

  if (!account) {
    const skipped = await IntegrationEvent.create({
      ...baseDoc,
      status: "skipped",
      statusReason: emailAddress
        ? `no-channel-account-for-${emailAddress}`
        : "missing-email-address",
    });
    return { event: skipped.toObject(), deduplicated: false };
  }

  const created = await IntegrationEvent.create({
    ...baseDoc,
    tenantId: account.tenantId,
    channelAccountId: account._id,
    status: "received",
  });

  let job = null;
  try {
    job = await enqueue(
      QUEUE_NAMES.INBOUND_WEBHOOKS,
      "gmail.history.received",
      {
        tenantId: String(account.tenantId),
        provider: "gmail",
        integrationEventId: String(created._id),
        channelAccountId: String(account._id),
        emailAddress,
        historyId,
      },
      { idempotencyKey: `gmail:history:${envelope.messageId}` },
    );
  } catch (err) {
    logger.error(
      `Failed to enqueue inbound.webhooks job for event ${created._id}: ${
        err?.message || err
      }`,
    );
  }

  if (job) {
    await IntegrationEvent.updateOne(
      { _id: created._id },
      {
        $set: {
          status: "enqueued",
          enqueuedJobId: String(job.id || ""),
          enqueuedAt: new Date(),
        },
      },
    );
    created.status = "enqueued";
    created.enqueuedJobId = String(job.id || "");
  }

  return { event: created.toObject(), deduplicated: false, job };
}

export const GmailPubsubIngestService = {
  decodePubsubEnvelope,
  ingestGmailPubsubEvent,
};
