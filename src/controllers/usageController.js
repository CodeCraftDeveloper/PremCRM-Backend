import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import { getTenantUsageSummary } from "../services/usageMeterService.js";

/**
 * GET /api/v1/tenants/:id/usage
 * Returns the tenant's plan limits, current-period usage, and headroom.
 *
 * Auth: protect + adminOnly is applied at the router level.
 * Tenant scope: regular admins can only read their own tenant; superadmins
 * can read any tenant's usage.
 */
const getTenantUsage = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const isSuperAdmin = req.user?.role === "superadmin";

  if (!isSuperAdmin && String(req.user?.tenantId) !== String(id)) {
    return next(
      ApiError.forbidden("You can only view usage for your own tenant"),
    );
  }

  const summary = await getTenantUsageSummary(id);
  if (!summary) {
    return next(ApiError.notFound("Tenant not found"));
  }

  return successResponse(res, summary);
});

export { getTenantUsage };
