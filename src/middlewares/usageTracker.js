import UsageMetric from "../models/UsageMetric.js";
import redis, { isRedisConnected } from "../config/redis.js";

// In-memory fallback for unique user tracking when Redis is unavailable
const localDailyUsers = new Map(); // key: "tenantId:date" → Set<userId>

function todayKey(tenantId) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `active_users:${tenantId}:${date}`;
}

/**
 * Middleware to track API calls per tenant per day.
 * Non-blocking — uses fire-and-forget increment.
 */
const trackApiUsage = (req, res, next) => {
  // Track after auth middleware has set tenantId
  const originalEnd = res.end.bind(res);
  res.end = function (...args) {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (tenantId && res.statusCode < 500) {
      UsageMetric.increment(tenantId, "apiCalls", 1);
    }
    return originalEnd(...args);
  };

  next();
};

/**
 * Track UNIQUE active users per day for a tenant.
 * Uses Redis SET (SADD) for deduplication; falls back to in-memory Set.
 * Only writes to UsageMetric when a genuinely new user is seen.
 */
const trackActiveUser = async (req, res, next) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId || !req.user?._id) return next();

  const userId = String(req.user._id);
  const key = todayKey(tenantId);

  try {
    if (isRedisConnected()) {
      // SADD returns 1 if the member was new, 0 if already present
      const added = await redis.sadd(key, userId);
      // Expire at end of day + 1h buffer (25 hours)
      await redis.expire(key, 90_000);
      if (added === 1) {
        // Get current unique count to set (not increment) the metric
        const count = await redis.scard(key);
        UsageMetric.setMetric(tenantId, "activeUsers", count);
      }
    } else {
      // In-memory fallback
      if (!localDailyUsers.has(key)) {
        localDailyUsers.set(key, new Set());
        // Cleanup old keys (keep only today)
        const today = new Date().toISOString().slice(0, 10);
        for (const k of localDailyUsers.keys()) {
          if (!k.includes(today)) localDailyUsers.delete(k);
        }
      }
      const userSet = localDailyUsers.get(key);
      if (!userSet.has(userId)) {
        userSet.add(userId);
        UsageMetric.setMetric(tenantId, "activeUsers", userSet.size);
      }
    }
  } catch {
    // Non-blocking — swallow errors
  }

  next();
};

export { trackApiUsage, trackActiveUser };
