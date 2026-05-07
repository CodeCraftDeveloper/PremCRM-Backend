import mongoose from "mongoose";

/**
 * IntegrationEvent — durable record of every inbound provider event
 * (Pub/Sub push, WhatsApp webhook, Meta webhook, GMB notification, etc.).
 *
 * Purpose:
 *   - Idempotency. The unique compound index on (provider, externalEventId)
 *     stops duplicate processing when providers retry the same delivery.
 *   - Audit. Every payload is preserved for 90 days so operators can
 *     inspect what was received before a feature regressed.
 *   - Hand-off. Workers downstream of the public webhook read this
 *     record (and not the raw HTTP body) to enrich CRM context.
 */

export const INTEGRATION_EVENT_PROVIDERS = Object.freeze([
  "gmail",
  "whatsapp",
  "meta",
  "gmb",
]);

export const INTEGRATION_EVENT_STATUSES = Object.freeze([
  "received",
  "enqueued",
  "processed",
  "failed",
  "skipped",
]);

const integrationEventSchema = new mongoose.Schema(
  {
    /**
     * Owning tenant. Optional at write time because the public webhook
     * may receive an event before we can resolve a ChannelAccount, but
     * if the tenant cannot be identified the event is stored with
     * status="skipped" and never enqueued.
     */
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
      index: true,
    },

    provider: {
      type: String,
      required: true,
      enum: INTEGRATION_EVENT_PROVIDERS,
    },

    /** Event family (e.g. "gmail.history", "whatsapp.message"). */
    eventType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },

    /**
     * Provider-side unique event ID — Pub/Sub messageId, WA event id, etc.
     * Combined with `provider` it dedupes retries from the provider.
     */
    externalEventId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },

    channelAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChannelAccount",
      default: null,
      index: true,
    },

    /** Raw provider envelope, kept for audit. Trimmed on read by workers. */
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    /** Whether the inbound request passed signature/token verification. */
    signatureVerified: {
      type: Boolean,
      default: false,
    },

    /** BullMQ job id once enqueued. */
    enqueuedJobId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 256,
    },

    enqueuedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: INTEGRATION_EVENT_STATUSES,
      default: "received",
    },

    /** Optional explanation for skipped/failed events. */
    statusReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1024,
    },
  },
  { timestamps: true, versionKey: false },
);

// Dedup: provider retries the same messageId — never process twice.
integrationEventSchema.index(
  { provider: 1, externalEventId: 1 },
  { unique: true, name: "integration_event_provider_external_uniq" },
);

// Tenant timeline lookup.
integrationEventSchema.index({ tenantId: 1, createdAt: -1 });

// Status filter for ops dashboards.
integrationEventSchema.index({ status: 1, createdAt: -1 });

// 90-day TTL keeps the audit horizon bounded.
integrationEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

const IntegrationEvent = mongoose.model(
  "IntegrationEvent",
  integrationEventSchema,
);

export default IntegrationEvent;
