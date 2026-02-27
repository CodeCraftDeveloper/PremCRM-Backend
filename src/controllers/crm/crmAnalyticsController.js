import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { CrmAnalyticsService } from "../../core/crm/index.js";

/**
 * @route   GET /api/v1/crm/analytics/funnel/:pipelineId
 */
export const dealFunnel = asyncHandler(async (req, res, next) => {
  try {
    const data = await CrmAnalyticsService.dealFunnel(
      req.user.tenantId,
      req.params.pipelineId,
    );
    successResponse(res, data, "Deal funnel data");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/analytics/lead-source
 */
export const leadSourcePerformance = asyncHandler(async (req, res, next) => {
  try {
    const data = await CrmAnalyticsService.leadSourcePerformance(
      req.user.tenantId,
    );
    successResponse(res, data, "Lead source performance data");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/analytics/owner-performance
 */
export const ownerPerformance = asyncHandler(async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await CrmAnalyticsService.ownerPerformance(req.user.tenantId, {
      startDate,
      endDate,
    });
    successResponse(res, data, "Owner performance data");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/analytics/stage-duration/:pipelineId
 */
export const stageDuration = asyncHandler(async (req, res, next) => {
  try {
    const data = await CrmAnalyticsService.stageDuration(
      req.user.tenantId,
      req.params.pipelineId,
    );
    successResponse(res, data, "Stage duration data");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/analytics/snapshot
 */
export const snapshot = asyncHandler(async (req, res, next) => {
  try {
    const data = await CrmAnalyticsService.snapshot(req.user.tenantId);
    successResponse(res, data, "CRM snapshot");
  } catch (error) {
    next(error);
  }
});
