import mongoose from "mongoose";

/**
 * UsageMeter — per-tenant, per-billing-period counters used for plan limits
 * and (eventually) Stripe metered-usage reporting.
 *
 * One document per (tenantId, period). `period` is a "YYYY-MM" UTC bucket
 * for the foundation; once subscription billing-cycle alignment lands,
 * the bucket key will be derived from `tenant.subscription.billingCycleStart`.
 *
 * Counters in this model correspond directly to the "*PerMonth" limits in
 * `config/planLimits.js`. Gauges (storageBytes) are written via $max so a
 * recalculation always reflects the largest observed value within the period.
 */
const usageMeterSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    period: {
      type: String, // "YYYY-MM" UTC
      required: true,
    },

    // Counters — incremented via $inc
    workflowRuns: { type: Number, default: 0 },
    aiRuns: { type: Number, default: 0 },
    aiTokens: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    socialPosts: { type: Number, default: 0 },
    reviewReplies: { type: Number, default: 0 },

    // Gauge — set with $max so we keep the high-water mark for the period
    storageBytes: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// One document per tenant per period
usageMeterSchema.index({ tenantId: 1, period: 1 }, { unique: true });

// Auto-purge meter docs older than ~25 months so we keep ~2 years of history
usageMeterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 65_000_000 });

const UsageMeter = mongoose.model("UsageMeter", usageMeterSchema);

export default UsageMeter;
