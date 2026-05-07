/**
 * Canonical queue names for Orbinest's BullMQ layer.
 *
 * Aligned with `docs/orbinest-brain/CTO_BLUEPRINT.md` §3 (Event and Queue
 * Architecture). Add new entries here only — never inline raw queue strings
 * elsewhere in the codebase.
 */
export const QUEUE_NAMES = Object.freeze({
  INBOUND_WEBHOOKS: "inbound.webhooks",
  GMAIL_SYNC: "gmail.sync",
  WHATSAPP_MESSAGES: "whatsapp.messages",
  META_SOCIAL_PUBLISH: "meta.social.publish",
  GMB_REVIEWS: "gmb.reviews",
  AI_DRAFT: "ai.draft",
  AI_CLASSIFY: "ai.classify",
  WORKFLOW_EXECUTE: "workflow.execute",
  NOTIFICATIONS_SEND: "notifications.send",
  ANALYTICS_ROLLUP: "analytics.rollup",
  BILLING_METER: "billing.meter",
  SMOKE_TEST: "smoke.test",
});

export const QUEUE_NAME_LIST = Object.freeze(Object.values(QUEUE_NAMES));

export const isKnownQueueName = (name) => QUEUE_NAME_LIST.includes(name);
