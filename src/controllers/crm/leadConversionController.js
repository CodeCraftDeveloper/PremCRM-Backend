import {
  asyncHandler,
  successResponse,
  ApiError,
} from "../../utils/apiResponse.js";
import { LeadConversionService } from "../../core/crm/index.js";

const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

// Only these keys are accepted for lead conversion
const ALLOWED_CONVERSION_KEYS = new Set([
  "createDeal",
  "dealName",
  "dealAmount",
  "pipelineId",
  "closingDate",
  "accountId",
  "ownerId",
  "initialDealStage",
]);

/**
 * @route   POST /api/v1/crm/leads/:id/convert
 */
export const convertLead = asyncHandler(async (req, res, next) => {
  try {
    // Reject unknown conversion keys
    const unknownKeys = Object.keys(req.body).filter(
      (k) => !ALLOWED_CONVERSION_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      return next(
        ApiError.badRequest(
          `Unknown conversion fields: ${unknownKeys.join(", ")}`,
        ),
      );
    }
    // Map frontend fields to service options
    const options = {};
    if (req.body.createDeal !== undefined)
      options.createDeal = req.body.createDeal;
    if (req.body.dealName) options.dealName = req.body.dealName;
    if (req.body.dealAmount) options.dealAmount = Number(req.body.dealAmount);
    if (req.body.pipelineId) options.pipelineId = req.body.pipelineId;
    if (req.body.closingDate) options.closingDate = req.body.closingDate;
    if (req.body.accountId) options.accountId = req.body.accountId;
    if (req.body.ownerId) options.ownerId = req.body.ownerId;
    if (req.body.initialDealStage)
      options.initialDealStage = req.body.initialDealStage;

    const result = await LeadConversionService.convert(
      req.user.tenantId,
      req.params.id,
      options,
      enrichUser(req),
    );
    successResponse(res, result, "Lead converted successfully", 201);
  } catch (error) {
    next(error);
  }
});
