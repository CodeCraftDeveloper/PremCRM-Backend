import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { BlueprintService } from "../../core/crm/index.js";

const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

/**
 * @route   GET /api/v1/crm/blueprints
 */
export const getBlueprints = asyncHandler(async (req, res, next) => {
  try {
    const { module } = req.query;
    const blueprints = await BlueprintService.list(req.user.tenantId, {
      module,
    });
    successResponse(res, blueprints, "Blueprints retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/blueprints/:id
 */
export const getBlueprint = asyncHandler(async (req, res, next) => {
  try {
    const blueprint = await BlueprintService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!blueprint) return next(ApiError.notFound("Blueprint not found"));
    successResponse(res, blueprint, "Blueprint retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/blueprints
 */
export const createBlueprint = asyncHandler(async (req, res, next) => {
  try {
    const blueprint = await BlueprintService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, blueprint, "Blueprint created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/blueprints/:id
 */
export const updateBlueprint = asyncHandler(async (req, res, next) => {
  try {
    const blueprint = await BlueprintService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!blueprint) return next(ApiError.notFound("Blueprint not found"));
    successResponse(res, blueprint, "Blueprint updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/crm/blueprints/:id
 */
export const deleteBlueprint = asyncHandler(async (req, res, next) => {
  try {
    const blueprint = await BlueprintService.remove(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!blueprint) return next(ApiError.notFound("Blueprint not found"));
    successResponse(res, null, "Blueprint deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/blueprints/validate
 * @desc    Validate a transition without executing it
 */
export const validateTransition = asyncHandler(async (req, res, next) => {
  try {
    const { module, fromStage, toStage, entityData } = req.body;
    if (!module || !fromStage || !toStage) {
      return next(
        ApiError.badRequest("module, fromStage, and toStage are required"),
      );
    }
    const result = await BlueprintService.validateTransition(
      req.user.tenantId,
      module,
      fromStage,
      toStage,
      req.user.role,
      entityData || {},
    );
    successResponse(res, result, "Transition validation result");
  } catch (error) {
    next(error);
  }
});
