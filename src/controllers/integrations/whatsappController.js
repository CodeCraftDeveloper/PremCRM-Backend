import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { WhatsappCloudService } from "../../services/whatsappCloudService.js";
import logger from "../../utils/logger.js";

export const listWhatsappAccounts = asyncHandler(async (req, res, next) => {
  try {
    const accounts = await WhatsappCloudService.listWhatsappAccounts(
      req.user.tenantId,
    );
    successResponse(res, accounts, "WhatsApp accounts loaded");
  } catch (error) {
    next(error);
  }
});

export const getWhatsappAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await WhatsappCloudService.getWhatsappAccount(
      req.user.tenantId,
      req.params.id,
    );
    successResponse(res, account, "WhatsApp account loaded");
  } catch (error) {
    next(error);
  }
});

export const connectWhatsappAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await WhatsappCloudService.connectWhatsappAccount(
      req.user.tenantId,
      req.user._id,
      req.body,
    );
    successResponse(res, account, "WhatsApp account connected", 201);
  } catch (error) {
    next(error);
  }
});

export const disconnectWhatsappAccount = asyncHandler(async (req, res, next) => {
  try {
    const account = await WhatsappCloudService.disconnectWhatsappAccount(
      req.user.tenantId,
      req.params.id,
      req.user._id,
    );
    successResponse(res, account, "WhatsApp account disconnected");
  } catch (error) {
    next(error);
  }
});

export const verifyWhatsappWebhook = asyncHandler(async (req, res, next) => {
  const verification = WhatsappCloudService.verifyWebhookChallenge(req.query);
  if (!verification.verified) {
    return next(ApiError.forbidden("WhatsApp webhook verification failed"));
  }

  return res.status(200).type("text/plain").send(verification.challenge);
});

export const handleWhatsappWebhook = asyncHandler(async (req, res) => {
  const result = await WhatsappCloudService.ingestWhatsappWebhook({
    body: req.body,
    headers: req.headers,
    rawBody: req.rawBody,
  });

  if (!result.accepted) {
    logger.warn(`WhatsApp webhook rejected: ${result.reason}`);
    return res.status(result.statusCode || 401).json({
      success: false,
      message: "WhatsApp webhook verification failed",
    });
  }

  return res.status(200).json({ success: true });
});
