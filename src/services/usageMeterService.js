import UsageMeter from "../models/UsageMeter.js";
import Tenant from "../models/Tenant.js";
import User from "../models/User.js";
import { getPlanLimits, resolveCanonicalPlan } from "./planService.js";

/**
 * Counter keys that map onto plan-limit fields ending in "PerMonth".
 * Adding a new counter requires:
 *   1. Adding the field to the UsageMeter schema.
 *   2. Adding the (limitKey -> counterKey) mapping in LIMIT_TO_COUNTER below.
 */
const COUNTER_KEYS = Object.freeze([
  "workflowRuns",
  "aiRuns",
  "aiTokens",
  "messagesSent",
  "socialPosts",
  "reviewReplies",
]);

const GAUGE_KEYS = Object.freeze(["storageBytes"]);

/**
 * Maps plan-limit keys to UsageMeter fields. Limits not present here
 * are computed live (e.g. seats from User collection).
 */
const LIMIT_TO_COUNTER = Object.freeze({
  maxWorkflowRunsPerMonth: "workflowRuns",
  maxAiRunsPerMonth: "aiRuns",
  maxMessagesPerMonth: "messagesSent",
  maxSocialPostsPerMonth: "socialPosts",
  maxReviewRepliesPerMonth: "reviewReplies",
  maxStorageBytes: "storageBytes",
});

/**
 * Build the "YYYY-MM" UTC period bucket for a given date.
 */
function getPeriodForDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Increment a usage counter for a tenant in the current billing period.
 * Returns a Promise that resolves to the updated meter document, or null
 * if the inputs are invalid. Errors are logged and re-thrown so callers
 * can decide whether to swallow them in fire-and-forget paths.
 */
async function incrementUsage(tenantId, counterKey, amount = 1) {
  if (!tenantId) return null;
  if (!COUNTER_KEYS.includes(counterKey)) {
    throw new Error(`[UsageMeter] Unknown counter key: ${counterKey}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const period = getPeriodForDate();

  return UsageMeter.findOneAndUpdate(
    { tenantId, period },
    { $inc: { [counterKey]: amount } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

/**
 * Set the storage gauge to at least `bytes` for the current period.
 * Uses $max so concurrent writes converge to the high-water mark.
 */
async function setStorageBytes(tenantId, bytes) {
  if (!tenantId) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;

  const period = getPeriodForDate();

  return UsageMeter.findOneAndUpdate(
    { tenantId, period },
    { $max: { storageBytes: Math.floor(bytes) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

/**
 * Read the current period meter document, returning a zeroed shape if absent.
 */
async function getCurrentPeriod(tenantId) {
  if (!tenantId) return null;

  const period = getPeriodForDate();
  const doc = await UsageMeter.findOne({ tenantId, period }).lean();

  if (doc) return doc;

  return {
    tenantId,
    period,
    workflowRuns: 0,
    aiRuns: 0,
    aiTokens: 0,
    messagesSent: 0,
    socialPosts: 0,
    reviewReplies: 0,
    storageBytes: 0,
  };
}

function buildHeadroom(used, limit) {
  if (limit === -1) {
    return {
      used,
      limit: -1,
      remaining: -1,
      percent: 0,
      exceeded: false,
      unlimited: true,
    };
  }
  const safeLimit = Math.max(limit, 0);
  const remaining = Math.max(safeLimit - used, 0);
  const percent =
    safeLimit === 0 ? 100 : Math.min(Math.round((used / safeLimit) * 100), 100);
  return {
    used,
    limit: safeLimit,
    remaining,
    percent,
    exceeded: used >= safeLimit,
    unlimited: false,
  };
}

/**
 * Build a tenant usage summary that combines plan limits, monthly counters,
 * and live gauges. Shape is stable so the UI can render headroom bars
 * without conditional logic per metric.
 */
async function getTenantUsageSummary(tenantId) {
  if (!tenantId) return null;

  const tenant = await Tenant.findById(tenantId)
    .select("name plan isActive subscription")
    .lean();
  if (!tenant) return null;

  const canonicalPlan = resolveCanonicalPlan(tenant.plan);
  const limits = getPlanLimits(tenant.plan);

  const period = getPeriodForDate();
  const meter = await getCurrentPeriod(tenantId);

  // Live seat count — users are a gauge, not a counter, so always recompute.
  const seats = await User.countDocuments({ tenantId, isActive: true });

  const usage = {
    seats,
    workflowRuns: meter.workflowRuns || 0,
    aiRuns: meter.aiRuns || 0,
    aiTokens: meter.aiTokens || 0,
    messagesSent: meter.messagesSent || 0,
    socialPosts: meter.socialPosts || 0,
    reviewReplies: meter.reviewReplies || 0,
    storageBytes: meter.storageBytes || 0,
  };

  const headroom = {
    seats: buildHeadroom(seats, limits.maxUsers),
    workflowRuns: buildHeadroom(
      usage.workflowRuns,
      limits.maxWorkflowRunsPerMonth,
    ),
    aiRuns: buildHeadroom(usage.aiRuns, limits.maxAiRunsPerMonth),
    messagesSent: buildHeadroom(
      usage.messagesSent,
      limits.maxMessagesPerMonth,
    ),
    socialPosts: buildHeadroom(
      usage.socialPosts,
      limits.maxSocialPostsPerMonth,
    ),
    reviewReplies: buildHeadroom(
      usage.reviewReplies,
      limits.maxReviewRepliesPerMonth,
    ),
    storageBytes: buildHeadroom(usage.storageBytes, limits.maxStorageBytes),
  };

  return {
    tenant: {
      id: tenant._id,
      name: tenant.name,
      plan: tenant.plan,
      planCanonical: canonicalPlan,
      isActive: tenant.isActive,
    },
    period,
    limits,
    usage,
    headroom,
  };
}

export {
  COUNTER_KEYS,
  GAUGE_KEYS,
  LIMIT_TO_COUNTER,
  getPeriodForDate,
  incrementUsage,
  setStorageBytes,
  getCurrentPeriod,
  getTenantUsageSummary,
};
