import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { DynamicFormService } from "../../core/crm/index.js";

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
 * @desc    List form definitions
 * @route   GET /api/v1/crm/metadata/forms
 */
export const getForms = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, moduleApiName, formType, search, isActive, sort } =
      req.query;
    const result = await DynamicFormService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      moduleApiName,
      formType,
      search,
      isActive:
        isActive === "true" ? true : isActive === "false" ? false : undefined,
      sort,
    });
    paginatedResponse(res, result.forms, result.pagination, "Forms retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single form definition
 * @route   GET /api/v1/crm/metadata/forms/:id
 */
export const getForm = asyncHandler(async (req, res, next) => {
  try {
    const form = await DynamicFormService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!form) return next(ApiError.notFound("Form not found"));
    successResponse(res, form, "Form retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get public form (no auth, tenant-scoped via slug)
 * @route   GET /api/v1/crm/metadata/forms/public/:tenantSlug/:apiName
 */
export const getPublicForm = asyncHandler(async (req, res, next) => {
  try {
    const { tenantSlug, apiName } = req.params;
    if (!tenantSlug) {
      return next(ApiError.badRequest("Tenant slug is required"));
    }
    const form = await DynamicFormService.getPublicForm(tenantSlug, apiName);
    if (!form) return next(ApiError.notFound("Form not found or inactive"));
    successResponse(res, form, "Public form retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create form definition
 * @route   POST /api/v1/crm/metadata/forms
 */
export const createForm = asyncHandler(async (req, res, next) => {
  try {
    const form = await DynamicFormService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, form, "Form created", 201);
  } catch (error) {
    if (error.statusCode === 409) return next(ApiError.conflict(error.message));
    if (error.statusCode === 400)
      return next(ApiError.badRequest(error.message));
    next(error);
  }
});

/**
 * @desc    Update form definition
 * @route   PUT /api/v1/crm/metadata/forms/:id
 */
export const updateForm = asyncHandler(async (req, res, next) => {
  try {
    const form = await DynamicFormService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!form) return next(ApiError.notFound("Form not found"));
    successResponse(res, form, "Form updated");
  } catch (error) {
    if (error.statusCode === 400)
      return next(ApiError.badRequest(error.message));
    next(error);
  }
});

/**
 * @desc    Delete form definition (soft)
 * @route   DELETE /api/v1/crm/metadata/forms/:id
 */
export const deleteForm = asyncHandler(async (req, res, next) => {
  try {
    const form = await DynamicFormService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!form) return next(ApiError.notFound("Form not found"));
    successResponse(res, null, "Form deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore form
 * @route   PATCH /api/v1/crm/metadata/forms/:id/restore
 */
export const restoreForm = asyncHandler(async (req, res, next) => {
  try {
    const form = await DynamicFormService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!form) return next(ApiError.notFound("Form not found or not deleted"));
    successResponse(res, form, "Form restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Duplicate a form
 * @route   POST /api/v1/crm/metadata/forms/:id/duplicate
 */
export const duplicateForm = asyncHandler(async (req, res, next) => {
  try {
    const { name } = req.body;
    const form = await DynamicFormService.duplicate(
      req.user.tenantId,
      req.params.id,
      name,
      enrichUser(req),
    );
    if (!form) return next(ApiError.notFound("Form not found"));
    successResponse(res, form, "Form duplicated", 201);
  } catch (error) {
    next(error);
  }
});
