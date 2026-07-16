import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { GoogleOAuthService } from "../../services/googleOAuthService.js";
import Tenant from "../../models/Tenant.js";
import ChannelAccount from "../../models/inbox/ChannelAccount.js";
import { planHasFeature, upgradeMessage } from "../../services/planService.js";

export const startGoogleOAuth = asyncHandler(async (req, res, next) => {
  try {
    const provider = req.query.provider || "gmail";
    if (!["gmail", "gmb"].includes(provider)) {
      return next(ApiError.badRequest("Invalid provider. Supported: gmail, gmb"));
    }

    // Gate access based on provider
    const requiredFeature = provider === "gmb" ? "gmbIntegration" : "gmailIntegration";
    if (req.user?.role !== "superadmin") {
      const tenant = await Tenant.findById(req.user.tenantId).select("plan").lean();
      const plan = tenant?.plan || "starter";
      if (!planHasFeature(plan, requiredFeature)) {
        return next(ApiError.forbidden(upgradeMessage(requiredFeature)));
      }
    }

    const result = await GoogleOAuthService.beginGoogleOAuth(
      req.user.tenantId,
      req.user._id,
      {
        redirectAfter: req.query.redirectAfter,
        requestIp: req.ip,
        provider,
      },
    );
    successResponse(res, result, "Google OAuth URL created");
  } catch (error) {
    next(error);
  }
});

export const handleGoogleOAuthCallback = asyncHandler(async (req, res, next) => {
  try {
    if (req.query.error) {
      return next(ApiError.badRequest(`Google OAuth failed: ${req.query.error}`));
    }

    const result = await GoogleOAuthService.exchangeGoogleOAuthCode(
      req.user.tenantId,
      req.user._id,
      {
        state: req.query.state,
        code: req.query.code,
        requestIp: req.ip,
      },
    );

    if (result.redirectUrl && !req.accepts("json")) {
      return res.redirect(302, result.redirectUrl);
    }

    successResponse(
      res,
      result.account,
      `${result.account.provider === "gmb" ? "GMB" : "Gmail"} account connected`
    );
  } catch (error) {
    next(error);
  }
});

export const refreshGoogleToken = asyncHandler(async (req, res, next) => {
  try {
    const account = await ChannelAccount.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      provider: { $in: ["gmail", "gmb"] },
      deletedAt: null,
    }).lean();

    if (!account) {
      return next(ApiError.notFound("Google channel account not found"));
    }

    // Gate access based on account provider
    const requiredFeature = account.provider === "gmb" ? "gmbIntegration" : "gmailIntegration";
    if (req.user?.role !== "superadmin") {
      const tenant = await Tenant.findById(req.user.tenantId).select("plan").lean();
      const plan = tenant?.plan || "starter";
      if (!planHasFeature(plan, requiredFeature)) {
        return next(ApiError.forbidden(upgradeMessage(requiredFeature)));
      }
    }

    const result = await GoogleOAuthService.refreshGoogleAccessToken(
      req.user.tenantId,
      req.params.id,
    );
    successResponse(
      res,
      result,
      `${account.provider === "gmb" ? "GMB" : "Gmail"} access token refreshed`
    );
  } catch (error) {
    next(error);
  }
});
