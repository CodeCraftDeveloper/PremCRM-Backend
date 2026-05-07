import { QUEUE_NAMES } from "./queueNames.js";

/**
 * Per-queue retry / retention overrides merged on top of `DEFAULT_JOB_OPTIONS`.
 *
 * The foundation default is 5 attempts with exponential backoff. That's wrong
 * for several real queues:
 *   - Provider sync (Gmail/WhatsApp/GMB/Meta) hits rate limits routinely and
 *     wants more attempts so the backoff has time to clear the window.
 *   - AI calls cost money — fewer retries.
 *   - Billing meter must NOT lose increments — more attempts and longer
 *     failed-job retention.
 *   - Idempotent rollups don't need 5 attempts.
 *
 * Per-job tuning still happens at the call site (e.g. a specific webhook
 * delivery sets its own `attempts`). Validation-style errors that should
 * never retry must be thrown as `NonRetryableError` (see `errors.js`).
 *
 * Each value is a partial of BullMQ's `JobsOptions` — shallow-merged onto
 * the defaults in `registry.js`.
 */
export const RETRY_POLICIES = Object.freeze({
  // Inbound webhooks: provider may resend; we want to drain transient errors
  [QUEUE_NAMES.INBOUND_WEBHOOKS]: { attempts: 8 },

  // Provider sync — generous retries so exponential backoff outlasts rate limits
  [QUEUE_NAMES.GMAIL_SYNC]: { attempts: 8 },
  [QUEUE_NAMES.WHATSAPP_MESSAGES]: { attempts: 6 },
  [QUEUE_NAMES.GMB_REVIEWS]: { attempts: 6 },
  [QUEUE_NAMES.META_SOCIAL_PUBLISH]: { attempts: 4 },

  // AI — limited retries, every attempt costs tokens
  [QUEUE_NAMES.AI_DRAFT]: { attempts: 3 },
  [QUEUE_NAMES.AI_CLASSIFY]: { attempts: 3 },

  // Workflow — moderate; node-level idempotency handles replay safety
  [QUEUE_NAMES.WORKFLOW_EXECUTE]: { attempts: 5 },

  // Notifications — moderate
  [QUEUE_NAMES.NOTIFICATIONS_SEND]: { attempts: 5 },

  // Idempotent — no point hammering Mongo
  [QUEUE_NAMES.ANALYTICS_ROLLUP]: { attempts: 3 },

  // Billing meter MUST NOT lose increments. Longer retention so we can
  // forensically replay any terminal failure.
  [QUEUE_NAMES.BILLING_METER]: {
    attempts: 10,
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  },

  // smoke.test stays on defaults (5 attempts) — useful for exercising the
  // failure path during operations testing.
});

export function getRetryPolicy(queueName) {
  return RETRY_POLICIES[queueName] || {};
}
