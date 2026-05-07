import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { GoogleOAuthService } from "../../services/googleOAuthService.js";

export const startGoogleOAuth = asyncHandler(async (req, res, next) => {
  try {
    const result = await GoogleOAuthService.beginGoogleOAuth(
      req.user.tenantId,
      req.user._id,
      {
        redirectAfter: req.query.redirectAfter,
        requestIp: req.ip,
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

    successResponse(res, result.account, "Gmail account connected");
  } catch (error) {
    next(error);
  }
});

export const refreshGoogleToken = asyncHandler(async (req, res, next) => {
  try {
    const result = await GoogleOAuthService.refreshGoogleAccessToken(
      req.user.tenantId,
      req.params.id,
    );
    successResponse(res, result, "Gmail access token refreshed");
  } catch (error) {
    next(error);
  }
});
