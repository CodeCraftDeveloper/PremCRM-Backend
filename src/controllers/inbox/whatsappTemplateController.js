import {
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";
import { WhatsappTemplateService } from "../../services/whatsappTemplateService.js";

export const listTemplates = asyncHandler(async (req, res, next) => {
  try {
    const { status, channelAccountId, search, page, limit } = req.query;
    const result = await WhatsappTemplateService.listTemplates({
      tenantId: req.user.tenantId,
      status: status || null,
      channelAccountId: channelAccountId || null,
      search: search || null,
      page,
      limit,
    });
    paginatedResponse(
      res,
      result.items,
      {
        page: result.page,
        limit: result.limit,
        totalDocs: result.totalDocs,
        totalPages: Math.ceil(result.totalDocs / result.limit) || 1,
      },
      "WhatsApp templates retrieved",
    );
  } catch (err) {
    next(err);
  }
});

export const upsertTemplate = asyncHandler(async (req, res, next) => {
  try {
    const {
      channelAccountId,
      name,
      language,
      category,
      status,
      components,
      metaTemplateId,
      statusReason,
    } = req.body || {};

    const template = await WhatsappTemplateService.upsertTemplate({
      tenantId: req.user.tenantId,
      channelAccountId: channelAccountId || null,
      name,
      language,
      category,
      status: status || "pending",
      components,
      metaTemplateId: metaTemplateId || null,
      statusReason: statusReason || null,
      createdBy: req.user._id,
    });

    successResponse(
      res,
      { template },
      "WhatsApp template saved",
      201,
    );
  } catch (err) {
    next(err);
  }
});

export const getTemplate = asyncHandler(async (req, res, next) => {
  try {
    const template = await WhatsappTemplateService.getTemplateById({
      tenantId: req.user.tenantId,
      id: req.params.id,
    });
    successResponse(res, { template }, "WhatsApp template retrieved");
  } catch (err) {
    next(err);
  }
});

export const deleteTemplate = asyncHandler(async (req, res, next) => {
  try {
    const result = await WhatsappTemplateService.deleteTemplate({
      tenantId: req.user.tenantId,
      id: req.params.id,
      deletedBy: req.user._id,
    });
    successResponse(res, result, "WhatsApp template deleted");
  } catch (err) {
    next(err);
  }
});
