import Tenant from "../models/Tenant.js";
import {
  planHasFeature,
  planMeetsTier,
  upgradeMessage,
} from "../services/planService.js";
import { ApiError } from "../utils/apiResponse.js";

/**
 * Resolve the tenant's current plan from the database.
 * Reads from req.user.tenantId or req.tenantId.
 * Caches the resolved plan on req._tenantPlan for the request lifetime.
 */
async function resolveTenantPlan(req) {
  if (req._tenantPlan !== undefined) return req._tenantPlan;

  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return null;

  const tenant = await Tenant.findById(tenantId).select("plan isActive").lean();
  if (!tenant || !tenant.isActive) return null;

  req._tenantPlan = tenant.plan;
  return tenant.plan;
}

/**
 * requirePlanFeature(featureName)
 *
 * Express middleware that gates a route behind a plan-level feature flag.
 * Superadmins bypass all plan checks.
 * Fails closed: denies access if plan cannot be resolved.
 *
 * Usage:
 *   router.get("/gmb/reviews", requirePlanFeature("gmbIntegration"), handler)
 *
 * @param {string} featureName - Key from planLimits.js features block
 * @returns {Function} Express middleware
 */
const requirePlanFeature = (featureName) => {
  return async (req, res, next) => {
    try {
      if (req.user?.role === "superadmin") return next();

      const plan = await resolveTenantPlan(req);
      if (!plan) {
        return next(ApiError.forbidden("Tenant plan could not be resolved."));
      }

      if (!planHasFeature(plan, featureName)) {
        return next(ApiError.forbidden(upgradeMessage(featureName)));
      }

      next();
    } catch (err) {
      console.error(
        `[PlanGate] Error checking feature '${featureName}':`,
        err.message,
      );
      return next(
        ApiError.forbidden(
          `Unable to verify plan access for '${featureName}'. Access denied.`,
        ),
      );
    }
  };
};

/**
 * requirePlanTier(minTier)
 *
 * Express middleware that gates a route behind a minimum plan tier.
 * Superadmins bypass all plan checks.
 * Fails closed.
 *
 * Usage:
 *   router.get("/agency/clients", requirePlanTier("agency"), handler)
 *
 * @param {"starter"|"growth"|"agency"|"enterprise"} minTier
 * @returns {Function} Express middleware
 */
const requirePlanTier = (minTier) => {
  return async (req, res, next) => {
    try {
      if (req.user?.role === "superadmin") return next();

      const plan = await resolveTenantPlan(req);
      if (!plan) {
        return next(ApiError.forbidden("Tenant plan could not be resolved."));
      }

      if (!planMeetsTier(plan, minTier)) {
        return next(ApiError.forbidden(upgradeMessage(minTier)));
      }

      next();
    } catch (err) {
      console.error(
        `[PlanGate] Error checking plan tier '${minTier}':`,
        err.message,
      );
      return next(
        ApiError.forbidden(
          `Unable to verify plan tier '${minTier}'. Access denied.`,
        ),
      );
    }
  };
};

export { requirePlanFeature, requirePlanTier };
