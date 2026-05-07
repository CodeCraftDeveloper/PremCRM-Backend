import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import { ContactService } from "../../core/crm/index.js";
import { emitCrmEvent } from "../../services/workflow/index.js";
import { filterCustomDataByRole } from "../../core/crm/customDataHelper.js";

/** Helper: enrich user obj with request metadata */
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
 * @desc    List contacts
 * @route   GET /api/v1/crm/contacts
 */
export const getContacts = asyncHandler(async (req, res, next) => {
  try {
    const { page, limit, ownerId, accountId, source, search } = req.query;
    const sortParam = req.query.sort || {
      field: req.query["sort[field]"],
      direction: req.query["sort[direction]"],
    };
    const result = await ContactService.list(req.user.tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      ownerId,
      accountId,
      source,
      search,
      sort: parseStructuredSort(sortParam.field ? sortParam : undefined),
    });
    result.contacts = await filterCustomDataByRole(
      req.user.tenantId,
      "contacts",
      result.contacts,
      req.user.role,
    );
    paginatedResponse(
      res,
      result.contacts,
      result.pagination,
      "Contacts retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single contact
 * @route   GET /api/v1/crm/contacts/:id
 */
export const getContact = asyncHandler(async (req, res, next) => {
  try {
    const contact = await ContactService.getById(
      req.user.tenantId,
      req.params.id,
    );
    if (!contact) return next(ApiError.notFound("Contact not found"));
    const filtered = await filterCustomDataByRole(
      req.user.tenantId,
      "contacts",
      contact,
      req.user.role,
    );
    successResponse(res, filtered, "Contact retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create contact
 * @route   POST /api/v1/crm/contacts
 */
export const createContact = asyncHandler(async (req, res, next) => {
  try {
    const contact = await ContactService.create(
      req.user.tenantId,
      req.body,
      enrichUser(req),
    );

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "contact",
      triggerType: "on_create",
      entity: contact.toObject ? contact.toObject() : contact,
      user: enrichUser(req),
    });

    successResponse(res, contact, "Contact created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update contact
 * @route   PUT /api/v1/crm/contacts/:id
 */
export const updateContact = asyncHandler(async (req, res, next) => {
  try {
    const contact = await ContactService.update(
      req.user.tenantId,
      req.params.id,
      req.body,
      enrichUser(req),
    );
    if (!contact) return next(ApiError.notFound("Contact not found"));

    // Fire v1 + v2 workflows via event bus
    emitCrmEvent({
      tenantId: req.user.tenantId,
      module: "contact",
      triggerType: "on_update",
      entity: contact.toObject ? contact.toObject() : contact,
      user: enrichUser(req),
    });

    successResponse(res, contact, "Contact updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete contact (soft)
 * @route   DELETE /api/v1/crm/contacts/:id
 */
export const deleteContact = asyncHandler(async (req, res, next) => {
  try {
    const contact = await ContactService.softDelete(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!contact) return next(ApiError.notFound("Contact not found"));
    successResponse(res, null, "Contact deleted");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore contact
 * @route   PATCH /api/v1/crm/contacts/:id/restore
 */
export const restoreContact = asyncHandler(async (req, res, next) => {
  try {
    const contact = await ContactService.restore(
      req.user.tenantId,
      req.params.id,
      enrichUser(req),
    );
    if (!contact)
      return next(ApiError.notFound("Contact not found or not deleted"));
    successResponse(res, contact, "Contact restored");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Assign owner
 * @route   PATCH /api/v1/crm/contacts/:id/assign
 */
export const assignContactOwner = asyncHandler(async (req, res, next) => {
  try {
    const { ownerId } = req.body;
    if (!ownerId) return next(ApiError.badRequest("ownerId is required"));
    const contact = await ContactService.assignOwner(
      req.user.tenantId,
      req.params.id,
      ownerId,
      enrichUser(req),
    );
    if (!contact) return next(ApiError.notFound("Contact not found"));
    successResponse(res, contact, "Contact owner assigned");
  } catch (error) {
    next(error);
  }
});
