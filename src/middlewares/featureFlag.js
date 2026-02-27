import TenantSettings from "../models/TenantSettings.js";
import { ApiError } from "../utils/apiResponse.js";

/**
 * Feature flag middleware.
 * Checks if a feature is enabled for the requesting tenant before allowing route execution.
 *
 * @param {string} featureName - Key in TenantSettings.features (e.g. "advancedAnalytics")
 * @returns {Function} Express middleware
 */
const requireFeature = (featureName) => {
  return async (req, res, next) => {
    try {
      // Superadmin bypasses feature flags
      if (req.user?.role === "superadmin") {
        return next();
      }

      const tenantId = req.tenantId || req.user?.tenantId;
      if (!tenantId) {
        return next(ApiError.forbidden("Tenant context required."));
      }

      const settings = await TenantSettings.getForTenant(tenantId);
      const isEnabled = settings?.features?.[featureName];

      if (!isEnabled) {
        return next(
          ApiError.forbidden(
            `Feature '${featureName}' is not enabled for your workspace. Contact your administrator.`,
          ),
        );
      }

      next();
    } catch (error) {
      // Fail-closed: if feature flag check fails, deny access (never fail open)
      console.error(
        `[FeatureFlag] Error checking '${featureName}' — denying access (fail-closed):`,
        error.message,
      );
      return next(
        ApiError.forbidden(
          `Unable to verify feature '${featureName}'. Access denied for safety. Please try again later.`,
        ),
      );
    }
  };
};

export { requireFeature };
