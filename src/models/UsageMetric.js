import mongoose from "mongoose";

/**
 * UsageMetric Schema — Per-tenant daily aggregate usage tracking
 * Persisted aggregates, NOT calculated on the fly.
 */
const usageMetricSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    date: {
      type: String, // "YYYY-MM-DD" format for easy grouping
      required: true,
    },
    leadsCreated: {
      type: Number,
      default: 0,
    },
    activeUsers: {
      type: Number,
      default: 0,
    },
    apiCalls: {
      type: Number,
      default: 0,
    },
    storageBytes: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound unique index — one document per tenant per day
usageMetricSchema.index({ tenantId: 1, date: 1 }, { unique: true });
usageMetricSchema.index({ tenantId: 1, date: -1 });

// TTL: auto-delete usage records older than 2 years
usageMetricSchema.index({ createdAt: 1 }, { expireAfterSeconds: 63_072_000 });

/**
 * Increment a metric for a tenant on a given day. Uses upsert.
 * @param {ObjectId} tenantId
 * @param {string} metric - field name to increment
 * @param {number} amount - amount to increment by (default 1)
 */
usageMetricSchema.statics.increment = function (tenantId, metric, amount = 1) {
  if (!tenantId) return;

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Fire-and-forget (non-blocking)
  setImmediate(() => {
    this.updateOne(
      { tenantId, date: today },
      { $inc: { [metric]: amount } },
      { upsert: true },
    ).catch((err) => {
      console.error("[UsageMetric] Failed to increment:", err.message);
    });
  });
};

/**
 * Set an absolute value for a metric (e.g., storage recalculation).
 */
usageMetricSchema.statics.setMetric = function (tenantId, metric, value) {
  if (!tenantId) return;

  const today = new Date().toISOString().slice(0, 10);

  setImmediate(() => {
    this.updateOne(
      { tenantId, date: today },
      { $set: { [metric]: value } },
      { upsert: true },
    ).catch((err) => {
      console.error("[UsageMetric] Failed to set metric:", err.message);
    });
  });
};

/**
 * Get usage for a tenant over a date range.
 */
usageMetricSchema.statics.getRange = function (tenantId, startDate, endDate) {
  return this.find({
    tenantId,
    date: { $gte: startDate, $lte: endDate },
  })
    .sort({ date: 1 })
    .lean();
};

const UsageMetric = mongoose.model("UsageMetric", usageMetricSchema);

export default UsageMetric;
