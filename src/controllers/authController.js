import User from "../models/User.js";
import Tenant from "../models/Tenant.js";
import ActivityLog from "../models/ActivityLog.js";
import AuditLog from "../models/AuditLog.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import AuthService from "../core/auth/AuthService.js";
import SessionService from "../core/auth/SessionService.js";
import logger from "../utils/logger.js";

const PLATFORM_TENANT_SLUG = "__platform__";
const normalizeBaseUrl = (value = "") => String(value).replace(/\/+$/, "");

const buildInviteAcceptUrl = (inviteToken) => {
  const encodedToken = encodeURIComponent(inviteToken);
  const template = process.env.INVITE_ACCEPT_URL_TEMPLATE;

  if (template && template.includes("{token}")) {
    return template.replace("{token}", encodedToken);
  }

  if (process.env.FRONTEND_URL) {
    return `${normalizeBaseUrl(process.env.FRONTEND_URL)}/accept-invite/${encodedToken}`;
  }

  return null;
};

// Shared cookie options for auth tokens.
// Cross-origin deployments (frontend ≠ backend domain) need SameSite=None.
const isProduction = process.env.NODE_ENV === "production";
const forceInsecureCookies =
  String(process.env.FORCE_INSECURE_COOKIES || "").toLowerCase() === "true";
const useSecureCookies = isProduction && !forceInsecureCookies;
const authCookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: useSecureCookies,
  sameSite: useSecureCookies ? "none" : "lax",
  ...(maxAge != null && { maxAge }),
});

/**
 * Extract S3 key from a direct S3 URL if it matches our bucket.
 */
const extractS3KeyFromLogoUrl = (url) => {
  if (!url) return null;
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) return null;
  const pattern = new RegExp(
    `^https?://${bucket}\\.s3[.-][^/]+\\.amazonaws\\.com/(.+?)(?:\\?.*)?$`,
  );
  const match = url.match(pattern);
  return match ? match[1] : null;
};

const resolveCompanyForResponse = async (company, tenantId) => {
  const resolved = { ...(company || {}) };
  // If logoS3Key is missing but logoUrl is an S3 URL, extract and backfill
  if (!resolved.logoS3Key && resolved.logoUrl) {
    const extracted = extractS3KeyFromLogoUrl(resolved.logoUrl);
    if (extracted) {
      resolved.logoS3Key = extracted;
      // Backfill in DB (fire-and-forget)
      Tenant.updateOne(
        { _id: tenantId },
        { $set: { "company.logoS3Key": extracted } },
      ).catch(() => {});
    }
  }
  return resolved;
};

const buildAuthUserPayload = (userDoc, tenantDoc = null) => ({
  ...(typeof userDoc?.toObject === "function" ? userDoc.toObject() : userDoc),
  tenantSlug: tenantDoc?.slug || null,
  tenantName: tenantDoc?.name || null,
  tenantCompany: tenantDoc?.company || {},
});

const mapAuthErrorToApiError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  const message = String(error?.message || "Authentication failed");
  const normalizedMessage = message.toLowerCase();
  const errorName = String(error?.name || "");

  if (message.toLowerCase().includes("too many failed attempts")) {
    return ApiError.tooManyRequests(message);
  }

  const isAuthFailure =
    errorName === "JsonWebTokenError" ||
    errorName === "TokenExpiredError" ||
    errorName === "NotBeforeError" ||
    normalizedMessage.includes("invalid credentials") ||
    normalizedMessage.includes("pending admin approval") ||
    normalizedMessage.includes("deactivated") ||
    normalizedMessage.includes("invalid refresh token") ||
    normalizedMessage.includes("refresh token required") ||
    normalizedMessage.includes("invalid signature") ||
    normalizedMessage.includes("jwt malformed") ||
    normalizedMessage.includes("jwt expired") ||
    normalizedMessage.includes("jwt not active");

  if (isAuthFailure) {
    return ApiError.unauthorized(message);
  }

  const isWorkspaceSelectionError =
    normalizedMessage.includes("multiple workspaces found") ||
    normalizedMessage.includes("tenant not found") ||
    normalizedMessage.includes("tenant is inactive") ||
    normalizedMessage.includes("workspace user limit reached");

  if (isWorkspaceSelectionError) {
    return ApiError.badRequest(message);
  }

  return ApiError.internal("Authentication service unavailable");
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res, next) => {
  const { email, password, tenantSlug } = req.body;

  try {
    const result = await AuthService.login(email, password, {
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
      tenantSlug,
    });

    // Set httpOnly secure cookies
    res.cookie(
      "accessToken",
      result.accessToken,
      authCookieOptions(15 * 60 * 1000),
    );
    res.cookie(
      "refreshToken",
      result.refreshToken,
      authCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    // Log activity
    await ActivityLog.create({
      tenantId: result.user.tenantId,
      user: result.user.id,
      action: "login",
      resourceType: "user",
      resourceId: result.user.id,
      description: `User logged in: ${result.user.email}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Audit log (async, non-blocking)
    AuditLog.record({
      tenantId: result.user.tenantId,
      userId: result.user.id,
      action: "user.login",
      entityType: "user",
      entityId: result.user.id,
      description: `User logged in: ${result.user.email}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(
      res,
      {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
      "Login successful",
    );
  } catch (error) {
    return next(mapAuthErrorToApiError(error));
  }
});

/**
 * @desc    Refresh access token
 * @route   POST /api/auth/refresh-token
 * @access  Public
 */
const refreshAccessToken = asyncHandler(async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!refreshToken) {
      return next(ApiError.unauthorized("Refresh token required"));
    }

    const tokens = await AuthService.refreshAccessToken(refreshToken);

    // Set new cookies
    res.cookie(
      "accessToken",
      tokens.accessToken,
      authCookieOptions(15 * 60 * 1000),
    );
    res.cookie(
      "refreshToken",
      tokens.refreshToken,
      authCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    successResponse(
      res,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
      "Token refreshed successfully",
    );
  } catch (error) {
    // If refresh fails, clear stale cookies so client can re-auth cleanly.
    res.clearCookie("accessToken", authCookieOptions());
    res.clearCookie("refreshToken", authCookieOptions());
    return next(mapAuthErrorToApiError(error));
  }
});

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res, next) => {
  try {
    // CRITICAL: Use SessionService.endSession() which CALCULATES duration
    const activeSessions = await SessionService.getUserActiveSessions(
      req.user._id,
      req.user.tenantId,
    );

    for (const session of activeSessions) {
      await SessionService.endSession(session._id, req.user.tenantId);
    }

    // Clear refresh token
    await User.findOneAndUpdate(
      { _id: req.user._id, tenantId: req.user.tenantId },
      { refreshToken: null },
    );

    // Log activity
    await ActivityLog.create({
      tenantId: req.user.tenantId,
      user: req.user._id,
      action: "logout",
      resourceType: "user",
      resourceId: req.user._id,
      description: `User logged out: ${req.user.email}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Audit log (async, non-blocking)
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "user.logout",
      entityType: "user",
      entityId: req.user._id,
      description: `User logged out: ${req.user.email}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Clear cookies — must match the options used when setting them
    res.clearCookie("accessToken", authCookieOptions());
    res.clearCookie("refreshToken", authCookieOptions());

    successResponse(res, null, "Logged out successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.user._id,
    tenantId: req.user.tenantId,
  }).populate("clientCount");

  const tenant = await Tenant.findById(req.user.tenantId)
    .select("slug name company")
    .lean();

  const company = await resolveCompanyForResponse(
    tenant?.company,
    req.user.tenantId,
  );

  const tenantWithResolvedCompany = tenant ? { ...tenant, company } : tenant;

  successResponse(res, {
    user: buildAuthUserPayload(user, tenantWithResolvedCompany),
  });
});

/**
 * @desc    Refresh current user session data (useful after logo updates)
 * @route   POST /api/auth/refresh-session
 * @access  Private
 */
const refreshSession = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.user._id,
    tenantId: req.user.tenantId,
  }).populate("clientCount");

  const tenant = await Tenant.findById(req.user.tenantId)
    .select("slug name company")
    .lean();

  const company = await resolveCompanyForResponse(
    tenant?.company,
    req.user.tenantId,
  );

  const tenantWithResolvedCompany = tenant ? { ...tenant, company } : tenant;

  successResponse(
    res,
    { user: buildAuthUserPayload(user, tenantWithResolvedCompany) },
    "Session refreshed successfully",
  );
});

/**
 * @desc    Update current user profile
 * @route   PUT /api/auth/me
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res, next) => {
  const { name, phone, avatar, notificationPreferences } = req.body;

  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;
  if (avatar !== undefined) update.avatar = avatar;
  if (notificationPreferences !== undefined) {
    update.notificationPreferences = notificationPreferences;
  }

  const user = await User.findOneAndUpdate(
    { _id: req.user._id, tenantId: req.user.tenantId },
    update,
    { new: true, runValidators: true },
  );

  const tenant = await Tenant.findById(req.user.tenantId)
    .select("slug name company")
    .lean();

  const company = await resolveCompanyForResponse(
    tenant?.company,
    req.user.tenantId,
  );

  const tenantWithResolvedCompany = tenant ? { ...tenant, company } : tenant;

  successResponse(
    res,
    { user: buildAuthUserPayload(user, tenantWithResolvedCompany) },
    "Profile updated successfully",
  );
});

/**
 * @desc    Change password
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  try {
    await AuthService.changePassword(
      req.user._id,
      req.user.tenantId,
      currentPassword,
      newPassword,
    );

    // Log activity
    await ActivityLog.create({
      tenantId: req.user.tenantId,
      user: req.user._id,
      action: "password_change",
      resourceType: "user",
      resourceId: req.user._id,
      description: `Password changed for: ${req.user.email}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Audit log (async, non-blocking)
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "user.password_change",
      entityType: "user",
      entityId: req.user._id,
      description: `Password changed for: ${req.user.email}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Clear cookies to force re-login — must match the options used when setting them
    res.clearCookie("accessToken", authCookieOptions());
    res.clearCookie("refreshToken", authCookieOptions());

    successResponse(
      res,
      null,
      "Password changed successfully. Please login again.",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Request password reset
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
const forgotPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;

  try {
    // AuthService handles token generation and hashing
    await AuthService.initiatePasswordReset(email);

    // Return same message for security (don't reveal if user exists)
    successResponse(
      res,
      null,
      "If an account with that email exists, a reset link has been sent.",
    );
  } catch (error) {
    // Still return success message for security
    successResponse(
      res,
      null,
      "If an account with that email exists, a reset link has been sent.",
    );
  }
});

/**
 * @desc    Create user invite (Admin only)
 * @route   POST /api/auth/invites
 * @access  Private (Admin/SuperAdmin)
 */
const createInvite = asyncHandler(async (req, res, next) => {
  const { email, role } = req.body;

  try {
    // AuthService handles invite creation with role enforcement
    const inviteResult = await AuthService.createInvite(
      email,
      role,
      req.user._id,
      req.user.tenantId,
    );

    // Log activity
    await ActivityLog.create({
      tenantId: req.user.tenantId,
      user: req.user._id,
      action: "invite_create",
      resourceType: "invite",
      resourceId: inviteResult.invite,
      description: `Invite created for: ${email} as ${role}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    logger.info(`Invite created by ${req.user.email} for ${email} as ${role}`);

    const inviteUrl = buildInviteAcceptUrl(inviteResult.token);

    successResponse(
      res,
      {
        invite: {
          id: inviteResult.invite,
          email,
          role,
          status: "pending",
        },
        inviteToken: inviteResult.token,
        inviteUrl,
      },
      "Invite created successfully",
      201,
    );
  } catch (error) {
    next(ApiError.badRequest(error.message));
  }
});

/**
 * @desc    Accept user invite and create account
 * @route   POST /api/auth/invites/:token/accept
 * @access  Public
 */
const acceptInvite = asyncHandler(async (req, res, next) => {
  const { token } = req.params;
  const { password, userName } = req.body;

  try {
    // AuthService accepts invite and auto-logs in user
    const result = await AuthService.acceptInvite(token, password, userName);

    // Set httpOnly cookies
    res.cookie(
      "accessToken",
      result.accessToken,
      authCookieOptions(15 * 60 * 1000),
    );
    res.cookie(
      "refreshToken",
      result.refreshToken,
      authCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    // Log activity
    await ActivityLog.create({
      tenantId: result.user.tenantId,
      user: result.user.id,
      action: "invite_accepted",
      resourceType: "user",
      resourceId: result.user.id,
      description: `User accepted invite and created account: ${result.user.email}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    logger.info(
      `Invite accepted and account created for: ${result.user.email} as ${result.user.role}`,
    );

    successResponse(
      res,
      {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
      "Account created and logged in successfully",
      201,
    );
  } catch (error) {
    next(ApiError.badRequest(error.message));
  }
});

/**
 * @desc    Public marketing manager registration (via old system)
 * @route   POST /api/auth/register-marketing-manager
 * @access  Public
 * @deprecated Use invite system instead
 */
const registerMarketingManager = asyncHandler(async (req, res, next) => {
  if (process.env.ENABLE_MARKETING_SELF_REGISTER !== "true") {
    return next(
      ApiError.forbidden(
        "Self-registration is disabled. Ask your admin for an invite.",
      ),
    );
  }

  const { name, email, password, phone, tenantSlug } = req.body;

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  // Resolve tenant from the provided tenantSlug.
  let tenant;

  if (tenantSlug) {
    const normalizedSlug = String(tenantSlug).trim().toLowerCase();
    tenant = await Tenant.findOne({ slug: normalizedSlug, isActive: true })
      .select("_id name slug settings activeUsers")
      .lean();

    if (!tenant) {
      return next(
        ApiError.badRequest(
          "Company workspace not found. Please check the Company ID provided by your admin.",
        ),
      );
    }

    // Check workspace user limit
    if (
      Number.isFinite(tenant?.settings?.maxUsers) &&
      tenant.activeUsers >= tenant.settings.maxUsers
    ) {
      return next(
        ApiError.badRequest(
          "This workspace has reached its user limit. Please contact the admin.",
        ),
      );
    }
  } else {
    // Fallback: auto-detect when only one tenant exists (backward compat)
    const activeTenants = await Tenant.find(
      { isActive: true, slug: { $ne: PLATFORM_TENANT_SLUG } },
      "_id name slug",
    )
      .limit(2)
      .lean();

    if (activeTenants.length === 1) {
      tenant = activeTenants[0];
    } else {
      return next(
        ApiError.badRequest(
          "Company ID is required. Please enter the Company ID provided by your admin.",
        ),
      );
    }
  }

  const existingUser = await User.findOne({
    tenantId: tenant._id,
    email: normalizedEmail,
  });

  if (existingUser) {
    return next(ApiError.conflict("User already exists with this email"));
  }

  const user = await User.create({
    tenantId: tenant._id,
    name: String(name || "").trim(),
    email: normalizedEmail,
    password,
    role: "marketing",
    phone: String(phone || "").trim(),
    isActive: false,
    approvalStatus: "pending",
  });

  // Do NOT increment tenant.activeUsers until admin approves

  await ActivityLog.create({
    tenantId: tenant._id,
    user: user._id,
    action: "register_marketing_manager_pending",
    resourceType: "user",
    resourceId: user._id,
    description: `Marketing manager registration pending approval: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  successResponse(
    res,
    {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        approvalStatus: user.approvalStatus,
      },
    },
    "Registration submitted successfully. Please wait for admin approval.",
    201,
  );
});

/**
 * @desc    Reset password
 * @route   POST /api/auth/reset-password/:token
 * @access  Public
 */
const resetPassword = asyncHandler(async (req, res, next) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    // AuthService handles validation and password reset
    const user = await AuthService.resetPassword(token, password);

    // Log activity
    await ActivityLog.create({
      tenantId: user.tenantId,
      user: user._id,
      action: "password_reset",
      resourceType: "user",
      resourceId: user._id,
      description: `Password reset completed for: ${user.email}`,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    logger.info(`Password reset completed for: ${user.email}`);

    // Clear cookies — must match the options used when setting them
    res.clearCookie("accessToken", authCookieOptions());
    res.clearCookie("refreshToken", authCookieOptions());

    successResponse(
      res,
      null,
      "Password reset successful. Please login with your new password.",
    );
  } catch (error) {
    next(
      ApiError.badRequest(error.message || "Invalid or expired reset token"),
    );
  }
});

export {
  login,
  refreshAccessToken,
  logout,
  getMe,
  refreshSession,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  registerMarketingManager,
  createInvite,
  acceptInvite,
};
