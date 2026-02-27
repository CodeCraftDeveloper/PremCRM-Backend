import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { CustomFieldService } from "../../core/crm/index.js";

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
 * @desc    List custom fields (optionally filter by module)
 * @route   GET /api/v1/crm/metadata/fields
 */
export const getCustomFields = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, moduleApiName, fieldType, search, isActive, sort } =
      req.query;
    const result = await CustomFieldService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100,
      moduleApiName,
      fieldType,
      search,
      isActive:
        isActive === "true" ? true : isActive === "false" ? false : undefined,
      sort,
    });
    paginatedResponse(
      res,
      result.fields,
      result.pagination,
      "Custom fields retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get fields for a specific module (role-filtered)
 * @route   GET /api/v1/crm/metadata/fields/module/:moduleApiName
 */
export const getFieldsByModule = asyncHandler(async (req, res, next) => {
  try {
    const fields = await CustomFieldService.getByModule(
      req.user.tenantId,
      req.params.moduleApiName,
      req.user.role,
    );
    successResponse(res, fields, "Module fields retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get full module metadata (fields + capacity + allowed types)
 * @route   GET /api/v1/crm/metadata/fields/module/:moduleApiName/metadata
 */
export const getModuleMetadata = asyncHandler(async (req, res, next) => {
  try {
    const metadata = await CustomFieldService.getModuleMetadata(
      req.user.tenantId,
      req.params.moduleApiName,
      req.user.role,
    );
    successResponse(res, metadata, "Module metadata retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single custom field
 * @route   GET /api/v1/crm/metadata/fields/:id
 */
export const getCustomField = asyncHandler(async (req, res, next) => {
  try {
    const field = await CustomFieldService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!field) return next(ApiError.notFound("Custom field not found"));
    successResponse(res, field, "Custom field retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create custom field
 * @route   POST /api/v1/crm/metadata/fields
 */
export const createCustomField = asyncHandler(async (req, res, next) => {
  try {
    const field = await CustomFieldService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );
    successResponse(res, field, "Custom field created", 201);
  } catch (error) {
    if (error.statusCode === 409) return next(ApiError.conflict(error.message));
    if (error.statusCode === 400)
      return next(ApiError.badRequest(error.message));
    next(error);
  }
});

/**
 * @desc    Update custom field
 * @route   PUT /api/v1/crm/metadata/fields/:id
 */
export const updateCustomField = asyncHandler(async (req, res, next) => {
  try {
    const field = await CustomFieldService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!field) return next(ApiError.notFound("Custom field not found"));
    successResponse(res, field, "Custom field updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete custom field (soft)
 * @route   DELETE /api/v1/crm/metadata/fields/:id
 */
export const deleteCustomField = asyncHandler(async (req, res, next) => {
  try {
    const field = await CustomFieldService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!field) return next(ApiError.notFound("Custom field not found"));
    successResponse(res, null, "Custom field deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore custom field
 * @route   PATCH /api/v1/crm/metadata/fields/:id/restore
 */
export const restoreCustomField = asyncHandler(async (req, res, next) => {
  try {
    const field = await CustomFieldService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!field)
      return next(ApiError.notFound("Custom field not found or not deleted"));
    successResponse(res, field, "Custom field restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Reorder custom fields within a module
 * @route   PATCH /api/v1/crm/metadata/fields/module/:moduleApiName/reorder
 */
export const reorderCustomFields = asyncHandler(async (req, res, next) => {
  try {
    const { fieldOrders } = req.body;
    if (!Array.isArray(fieldOrders) || fieldOrders.length === 0) {
      return next(ApiError.badRequest("fieldOrders array is required"));
    }
    const result = await CustomFieldService.reorder(
      req.user.tenantId,
      req.params.moduleApiName,
      fieldOrders,
      enrichUser(req),
    );
    successResponse(res, result, "Fields reordered");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Validate custom data for a module
 * @route   POST /api/v1/crm/metadata/fields/module/:moduleApiName/validate
 */
export const validateCustomData = asyncHandler(async (req, res, next) => {
  try {
    const result = await CustomFieldService.validateCustomData(
      req.user.tenantId,
      req.params.moduleApiName,
      req.body,
      req.user.role,
    );
    successResponse(
      res,
      result,
      result.valid ? "Validation passed" : "Validation failed",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Resolve reference fields on a custom data object
 * @route   POST /api/v1/crm/metadata/fields/module/:moduleApiName/resolve
 */
export const resolveReferences = asyncHandler(async (req, res, next) => {
  try {
    const resolved = await CustomFieldService.resolveReferences(
      req.user.tenantId,
      req.params.moduleApiName,
      req.body,
    );
    successResponse(res, resolved, "References resolved");
  } catch (error) {
    next(error);
  }
});
