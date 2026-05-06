import PLAN_LIMITS, { PLAN_ALIASES, PLAN_TIERS } from "../config/planLimits.js";

/**
 * Resolve the canonical plan tier name for a raw plan value.
 * Handles legacy aliases ("free" → "starter", "pro" → "growth").
 * Falls back to "starter" for unknown values.
 */
function resolveCanonicalPlan(rawPlan) {
  if (!rawPlan) return "starter";
  const alias = PLAN_ALIASES[rawPlan];
  if (alias) return alias;
  if (PLAN_LIMITS[rawPlan]) return rawPlan;
  return "starter";
}

/**
 * Return the full limits+features config for a plan value.
 * Accepts raw plan values ("free", "pro", "starter", "growth", "agency", "enterprise").
 */
function getPlanConfig(rawPlan) {
  const canonical = resolveCanonicalPlan(rawPlan);
  return PLAN_LIMITS[canonical];
}

/**
 * Return the limits block for a plan value.
 */
function getPlanLimits(rawPlan) {
  return getPlanConfig(rawPlan).limits;
}

/**
 * Return the features block for a plan value.
 */
function getPlanFeatures(rawPlan) {
  return getPlanConfig(rawPlan).features;
}

/**
 * Check whether a plan includes a specific feature.
 *
 * @param {string} rawPlan - Tenant plan field value
 * @param {string} featureName - Key from the features block in planLimits.js
 * @returns {boolean}
 */
function planHasFeature(rawPlan, featureName) {
  const features = getPlanFeatures(rawPlan);
  return features[featureName] === true;
}

/**
 * Check whether a plan's numeric limit would be exceeded by a proposed count.
 * Returns true when the action is ALLOWED (i.e. not at limit).
 *
 * @param {string} rawPlan - Tenant plan field value
 * @param {string} limitKey - Key from the limits block (e.g. "maxUsers")
 * @param {number} currentCount - Current usage count
 * @returns {boolean} true = allowed, false = limit reached
 */
function planAllowsMore(rawPlan, limitKey, currentCount) {
  const limits = getPlanLimits(rawPlan);
  const max = limits[limitKey];
  if (max === -1) return true; // unlimited
  return currentCount < max;
}

/**
 * Return the tier index for a plan value (higher = more capable).
 * "starter" = 0, "growth" = 1, "agency" = 2, "enterprise" = 3.
 */
function planTierIndex(rawPlan) {
  const canonical = resolveCanonicalPlan(rawPlan);
  const idx = PLAN_TIERS.indexOf(canonical);
  return idx === -1 ? 0 : idx;
}

/**
 * Check whether a plan meets or exceeds a required minimum tier.
 *
 * @param {string} rawPlan - Tenant plan field value
 * @param {string} minTier - Minimum required tier ("starter"|"growth"|"agency"|"enterprise")
 * @returns {boolean}
 */
function planMeetsTier(rawPlan, minTier) {
  return planTierIndex(rawPlan) >= planTierIndex(minTier);
}

/**
 * Build a human-readable upgrade message for feature gates.
 */
function upgradeMessage(featureOrTier) {
  return `This feature is not available on your current plan. Upgrade to access '${featureOrTier}'.`;
}

export {
  resolveCanonicalPlan,
  getPlanConfig,
  getPlanLimits,
  getPlanFeatures,
  planHasFeature,
  planAllowsMore,
  planTierIndex,
  planMeetsTier,
  upgradeMessage,
};
