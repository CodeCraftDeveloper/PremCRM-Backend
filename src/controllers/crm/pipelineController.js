import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { PipelineService } from "../../core/crm/index.js";

const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

/**
 * @route   GET /api/v1/crm/pipelines
 */
export const getPipelines = asyncHandler(async (req, res, next) => {
  try {
    const pipelines = await PipelineService.list(req.user.tenantId);
    successResponse(res, pipelines, "Pipelines retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/pipelines/:id
 */
export const getPipeline = asyncHandler(async (req, res, next) => {
  try {
    const pipeline = await PipelineService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!pipeline) return next(ApiError.notFound("Pipeline not found"));
    successResponse(res, pipeline, "Pipeline retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/pipelines
 */
export const createPipeline = asyncHandler(async (req, res, next) => {
  try {
    const pipeline = await PipelineService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, pipeline, "Pipeline created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/pipelines/:id
 */
export const updatePipeline = asyncHandler(async (req, res, next) => {
  try {
    const pipeline = await PipelineService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!pipeline) return next(ApiError.notFound("Pipeline not found"));
    successResponse(res, pipeline, "Pipeline updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/pipelines/:id/stages
 */
export const updatePipelineStages = asyncHandler(async (req, res, next) => {
  try {
    const { stages } = req.body;
    if (!stages || !Array.isArray(stages))
      return next(ApiError.badRequest("stages array is required"));
    const pipeline = await PipelineService.updateStages(
      req.user.tenantId,
      req.params.id,
      stages,
      enrichUser(req),
    );
    if (!pipeline) return next(ApiError.notFound("Pipeline not found"));
    successResponse(res, pipeline, "Pipeline stages updated");
  } catch (error) {
    next(error);
  }
});
