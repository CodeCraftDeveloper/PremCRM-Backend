import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { CrmActivityService } from "../../core/crm/index.js";
import { emitCrmEvent } from "../../services/workflow/index.js";
import { filterCustomDataByRole } from "../../core/crm/customDataHelper.js";

const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

const parseStructuredSort = (sort) => {
  if (sort === undefined) return undefined;
  if (!sort || typeof sort !== "object" || Array.isArray(sort)) {
    throw ApiError.badRequest("sort must be an object { field, direction }");
  }
  const { field, direction } = sort;
  if (!field || !["asc", "desc"].includes(direction)) {
    throw ApiError.badRequest("sort must include field and direction");
  }
  return { field, direction };
};

/**
 * @route   GET /api/v1/crm/activities
 */
export const getActivities = asyncHandler(async (req, res, next) => {
  try {
    const {
      page,
      limit,
      type,
      status,
      ownerId,
      entityType,
      entityId,
      dueBefore,
    } = req.query;
    const sortParam = req.query.sort || {
      field: req.query["sort[field]"],
      direction: req.query["sort[direction]"],
    };
    const result = await CrmActivityService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      type,
      status,
      ownerId,
      entityType,
      entityId,
      dueBefore,
      sort: parseStructuredSort(sortParam.field ? sortParam : undefined),
    });
    result.activities = await filterCustomDataByRole(
      req.user.tenantId,
      "activities",
      result.activities,
      req.user.role,
    );
    paginatedResponse(
      res,
      result.activities,
      result.pagination,
      "Activities retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/activities/:id
 */
export const getActivity = asyncHandler(async (req, res, next) => {
  try {
    const activity = await CrmActivityService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!activity) return next(ApiError.notFound("Activity not found"));
    const filtered = await filterCustomDataByRole(
      req.user.tenantId,
      "activities",
      activity,
      req.user.role,
    );
    successResponse(res, filtered, "Activity retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/activities/entity/:entityType/:entityId
 */
export const getActivitiesForEntity = asyncHandler(async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    const { page, limit } = req.query;
    const result = await CrmActivityService.getForEntity(
      req.user.tenantId,
      entityType,
      entityId,
      {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
      },
    );
    paginatedResponse(
      res,
      result.activities,
      result.pagination,
      "Activities retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/activities
 */
export const createActivity = asyncHandler(async (req, res, next) => {
  try {
    const activity = await CrmActivityService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "activity",
      triggerType: "on_create",
      entity: activity.toObject ? activity.toObject() : activity,
      user: enrichUser(req),
    });

    successResponse(res, activity, "Activity created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/activities/:id
 */
export const updateActivity = asyncHandler(async (req, res, next) => {
  try {
    const activity = await CrmActivityService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!activity) return next(ApiError.notFound("Activity not found"));

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "activity",
      triggerType: "on_update",
      entity: activity.toObject ? activity.toObject() : activity,
      user: enrichUser(req),
    });

    successResponse(res, activity, "Activity updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/crm/activities/:id
 */
export const deleteActivity = asyncHandler(async (req, res, next) => {
  try {
    const activity = await CrmActivityService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!activity) return next(ApiError.notFound("Activity not found"));
    successResponse(res, null, "Activity deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/activities/:id/restore
 */
export const restoreActivity = asyncHandler(async (req, res, next) => {
  try {
    const activity = await CrmActivityService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!activity)
      return next(ApiError.notFound("Activity not found or not deleted"));
    successResponse(res, activity, "Activity restored");
  } catch (error) {
    next(error);
  }
});
