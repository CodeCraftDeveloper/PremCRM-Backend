import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { DealService } from "../../core/crm/index.js";
import { WorkflowEngine } from "../../core/crm/index.js";
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
 * @route   GET /api/v1/crm/deals
 */
export const getDeals = asyncHandler(async (req, res, next) => {
  try {
    const {
      page,
      limit,
      pipelineId,
      stage,
      ownerId,
      contactId,
      accountId,
      search,
    } = req.query;
    const sortParam = req.query.sort || {
      field: req.query["sort[field]"],
      direction: req.query["sort[direction]"],
    };
    const result = await DealService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      pipelineId,
      stage,
      ownerId,
      contactId,
      accountId,
      search,
      sort: parseStructuredSort(sortParam.field ? sortParam : undefined),
    });
    result.deals = await filterCustomDataByRole(
      req.user.tenantId,
      "deals",
      result.deals,
      req.user.role,
    );
    paginatedResponse(res, result.deals, result.pagination, "Deals retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/deals/:id
 */
export const getDeal = asyncHandler(async (req, res, next) => {
  try {
    const deal = await DealService.getById(req.user.tenantId, req.params.id);
    if (!deal) return next(ApiError.notFound("Deal not found"));
    const filtered = await filterCustomDataByRole(
      req.user.tenantId,
      "deals",
      deal,
      req.user.role,
    );
    successResponse(res, filtered, "Deal retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/deals
 */
export const createDeal = asyncHandler(async (req, res, next) => {
  try {
    const user = enrichUser(req);
    const deal = await DealService.create(req.user.tenantId, req.body, user);

    // Fire workflow
    WorkflowEngine.fire({
      tenantId: req.user.tenantId,
      module: "deal",
      triggerType: "on_create",
      entity: deal.toObject(),
      user,
    });

    successResponse(res, deal, "Deal created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/deals/:id
 */
export const updateDeal = asyncHandler(async (req, res, next) => {
  try {
    const user = enrichUser(req);
    const deal = await DealService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      user,
    );
    if (!deal) return next(ApiError.notFound("Deal not found"));

    WorkflowEngine.fire({
      tenantId: req.user.tenantId,
      module: "deal",
      triggerType: "on_update",
      entity: deal.toObject(),
      user,
    });

    successResponse(res, deal, "Deal updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/deals/:id/stage
 */
export const changeDealStage = asyncHandler(async (req, res, next) => {
  try {
    const { stage } = req.body;
    if (!stage) return next(ApiError.badRequest("stage is required"));

    const user = enrichUser(req);
    const dealBefore = await DealService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!dealBefore) return next(ApiError.notFound("Deal not found"));

    const oldStage = dealBefore.stage;
    const deal = await DealService.changeStage(
      req.user.tenantId,
      req.params.id,
      stage,
      user,
    );

    // Fire stage-change workflow
    WorkflowEngine.fire({
      tenantId: req.user.tenantId,
      module: "deal",
      triggerType: "on_stage_change",
      entity: deal.toObject(),
      changes: { stage: { old: oldStage, new: stage } },
      user,
    });

    successResponse(res, deal, `Deal moved to ${stage}`);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/crm/deals/:id
 */
export const deleteDeal = asyncHandler(async (req, res, next) => {
  try {
    const deal = await DealService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!deal) return next(ApiError.notFound("Deal not found"));
    successResponse(res, null, "Deal deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/deals/:id/restore
 */
export const restoreDeal = asyncHandler(async (req, res, next) => {
  try {
    const deal = await DealService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!deal) return next(ApiError.notFound("Deal not found or not deleted"));
    successResponse(res, deal, "Deal restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/deals/:id/assign
 */
export const assignDealOwner = asyncHandler(async (req, res, next) => {
  try {
    const { ownerId } = req.body;
    if (!ownerId) return next(ApiError.badRequest("ownerId is required"));
    const deal = await DealService.assignOwner(
      req.user.tenantId,
      req.params.id,
      ownerId,
      enrichUser(req),
    );
    if (!deal) return next(ApiError.notFound("Deal not found"));
    successResponse(res, deal, "Deal owner assigned");
  } catch (error) {
    next(error);
  }
});
