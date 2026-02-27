import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { LayoutService } from "../../core/crm/index.js";

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
 * @desc    List layouts
 * @route   GET /api/v1/crm/metadata/layouts
 */
export const getLayouts = asyncHandler(async (req, res, next) => {
  try {
    const { moduleApiName, layoutType, isActive, sort } = req.query;
    const layouts = await LayoutService.list(req.user.tenantId, {
      moduleApiName,
      layoutType,
      isActive:
        isActive === "true" ? true : isActive === "false" ? false : undefined,
      sort,
    });
    successResponse(res, layouts, "Layouts retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single layout
 * @route   GET /api/v1/crm/metadata/layouts/:id
 */
export const getLayout = asyncHandler(async (req, res, next) => {
  try {
    const layout = await LayoutService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!layout) return next(ApiError.notFound("Layout not found"));
    successResponse(res, layout, "Layout retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get active layout for module + type
 * @route   GET /api/v1/crm/metadata/layouts/active/:moduleApiName/:layoutType
 */
export const getActiveLayout = asyncHandler(async (req, res, next) => {
  try {
    const { moduleApiName, layoutType } = req.params;
    const layout = await LayoutService.getActiveLayout(
      req.user.tenantId,
      moduleApiName,
      layoutType,
    );
    if (!layout) return next(ApiError.notFound("No active layout found"));
    successResponse(res, layout, "Active layout retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create or update (upsert) a layout
 * @route   POST /api/v1/crm/metadata/layouts
 */
export const upsertLayout = asyncHandler(async (req, res, next) => {
  try {
    const { moduleApiName, layoutType } = req.body;
    if (!moduleApiName || !layoutType) {
      return next(
        ApiError.badRequest("moduleApiName and layoutType are required"),
      );
    }
    const layout = await LayoutService.upsert(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, layout, "Layout saved", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update a layout
 * @route   PUT /api/v1/crm/metadata/layouts/:id
 */
export const updateLayout = asyncHandler(async (req, res, next) => {
  try {
    const layout = await LayoutService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!layout) return next(ApiError.notFound("Layout not found"));
    successResponse(res, layout, "Layout updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete a layout
 * @route   DELETE /api/v1/crm/metadata/layouts/:id
 */
export const deleteLayout = asyncHandler(async (req, res, next) => {
  try {
    const layout = await LayoutService.remove(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!layout) return next(ApiError.notFound("Layout not found"));
    successResponse(res, null, "Layout deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Add section to layout
 * @route   POST /api/v1/crm/metadata/layouts/:id/sections
 */
export const addLayoutSection = asyncHandler(async (req, res, next) => {
  try {
    const layout = await LayoutService.addSection(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!layout) return next(ApiError.notFound("Layout not found"));
    successResponse(res, layout, "Section added");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Reorder sections in a layout
 * @route   PATCH /api/v1/crm/metadata/layouts/:id/sections/reorder
 */
export const reorderLayoutSections = asyncHandler(async (req, res, next) => {
  try {
    const { sectionOrders } = req.body;
    if (!Array.isArray(sectionOrders) || sectionOrders.length === 0) {
      return next(ApiError.badRequest("sectionOrders array is required"));
    }
    const layout = await LayoutService.reorderSections(
      req.user.tenantId,
      req.params.id,
      sectionOrders,
      enrichUser(req),
    );
    if (!layout) return next(ApiError.notFound("Layout not found"));
    successResponse(res, layout, "Sections reordered");
  } catch (error) {
    next(error);
  }
});
