import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { AccountService } from "../../core/crm/index.js";
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
 * @route   GET /api/v1/crm/accounts
 */
export const getAccounts = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, ownerId, type, industry, search } = req.query;
    const sortParam = req.query.sort || {
      field: req.query["sort[field]"],
      direction: req.query["sort[direction]"],
    };
    const result = await AccountService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      ownerId,
      type,
      industry,
      search,
      sort: parseStructuredSort(sortParam.field ? sortParam : undefined),
    });
    result.accounts = await filterCustomDataByRole(
      req.user.tenantId,
      "accounts",
      result.accounts,
      req.user.role,
    );
    paginatedResponse(
      res,
      result.accounts,
      result.pagination,
      "Accounts retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/accounts/:id
 */
export const getAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await AccountService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!account) return next(ApiError.notFound("Account not found"));
    const filtered = await filterCustomDataByRole(
      req.user.tenantId,
      "accounts",
      account,
      req.user.role,
    );
    successResponse(res, filtered, "Account retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/accounts
 */
export const createAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await AccountService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "account",
      triggerType: "on_create",
      entity: account.toObject ? account.toObject() : account,
      user: enrichUser(req),
    });

    successResponse(res, account, "Account created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/accounts/:id
 */
export const updateAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await AccountService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!account) return next(ApiError.notFound("Account not found"));

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "account",
      triggerType: "on_update",
      entity: account.toObject ? account.toObject() : account,
      user: enrichUser(req),
    });

    successResponse(res, account, "Account updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/crm/accounts/:id
 */
export const deleteAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await AccountService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!account) return next(ApiError.notFound("Account not found"));
    successResponse(res, null, "Account deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/accounts/:id/restore
 */
export const restoreAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await AccountService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!account)
      return next(ApiError.notFound("Account not found or not deleted"));
    successResponse(res, account, "Account restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/crm/accounts/:id/assign
 */
export const assignAccountOwner = asyncHandler(async (req, res, next) => {
  try {
    const { ownerId } = req.body;
    if (!ownerId) return next(ApiError.badRequest("ownerId is required"));
    const account = await AccountService.assignOwner(
      req.user.tenantId,
      req.params.id,
      ownerId,
      enrichUser(req),
    );
    if (!account) return next(ApiError.notFound("Account not found"));
    successResponse(res, account, "Account owner assigned");
  } catch (error) {
    next(error);
  }
});
