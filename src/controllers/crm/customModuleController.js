import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { CustomModuleService } from "../../core/crm/index.js";

/** Helper: enrich user obj with request metadata */
const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

/**
 * @desc    List custom modules
 * @route   GET /api/v1/crm/metadata/modules
 */
export const getCustomModules = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, search, isActive, sort } = req.query;
    const result = await CustomModuleService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      search,
      isActive:
        isActive === "true" ? true : isActive === "false" ? false : undefined,
      sort,
    });
    paginatedResponse(
      res,
      result.modules,
      result.pagination,
      "Custom modules retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single custom module
 * @route   GET /api/v1/crm/metadata/modules/:id
 */
export const getCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!mod) return next(ApiError.notFound("Custom module not found"));
    successResponse(res, mod, "Custom module retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get custom module by apiName
 * @route   GET /api/v1/crm/metadata/modules/by-name/:apiName
 */
export const getCustomModuleByName = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.getByApiName(
      req.user.tenantId,
      req.params.apiName,
    );
    if (!mod) return next(ApiError.notFound("Custom module not found"));
    successResponse(res, mod, "Custom module retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create custom module
 * @route   POST /api/v1/crm/metadata/modules
 */
export const createCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, mod, "Custom module created", 201);
  } catch (error) {
    if (error.statusCode === 409) return next(ApiError.conflict(error.message));
    next(error);
  }
});

/**
 * @desc    Update custom module
 * @route   PUT /api/v1/crm/metadata/modules/:id
 */
export const updateCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!mod) return next(ApiError.notFound("Custom module not found"));
    successResponse(res, mod, "Custom module updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete custom module (soft)
 * @route   DELETE /api/v1/crm/metadata/modules/:id
 */
export const deleteCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!mod)
      return next(
        ApiError.notFound("Custom module not found or is a system module"),
      );
    successResponse(res, null, "Custom module deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore custom module
 * @route   PATCH /api/v1/crm/metadata/modules/:id/restore
 */
export const restoreCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!mod)
      return next(ApiError.notFound("Custom module not found or not deleted"));
    successResponse(res, mod, "Custom module restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Toggle module active state
 * @route   PATCH /api/v1/crm/metadata/modules/:id/toggle
 */
export const toggleCustomModule = asyncHandler(async (req, res, next) => {
  try {
    const mod = await CustomModuleService.toggleActive(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!mod) return next(ApiError.notFound("Custom module not found"));
    successResponse(
      res,
      mod,
      `Custom module ${mod.isActive ? "activated" : "deactivated"}`,
    );
  } catch (error) {
    next(error);
  }
});
