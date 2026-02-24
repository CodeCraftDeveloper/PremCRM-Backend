import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import UserSession from "../models/UserSession.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateRandomToken,
  hashToken,
} from "../utils/jwt.js";
import logger from "../utils/logger.js";

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  // Check if user exists
  const user = await User.findOne({ email }).select("+password +refreshToken");

  if (!user) {
    return next(ApiError.unauthorized("Invalid credentials"));
  }

  // Check if user is active
  if (!user.isActive) {
    return next(
      ApiError.unauthorized(
        "Your account has been deactivated. Please contact admin.",
      ),
    );
  }

  // Check password
  const isMatch = await user.comparePassword(password);

  if (!isMatch) {
    return next(ApiError.unauthorized("Invalid credentials"));
  }

  // Generate tokens
  const accessToken = generateAccessToken({ id: user._id, role: user.role });
  const refreshToken = generateRefreshToken({ id: user._id });

  // Save refresh token to database
  user.refreshToken = refreshToken;
  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  // Log activity
  await ActivityLog.log({
    user: user._id,
    action: "login",
    resourceType: "user",
    resourceId: user._id,
    description: `User logged in: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`User logged in: ${user.email}`);

  // Send response
  successResponse(
    res,
    {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
      accessToken,
      refreshToken,
    },
    "Login successful",
  );
});

/**
 * @desc    Refresh access token
 * @route   POST /api/auth/refresh-token
 * @access  Public
 */
const refreshAccessToken = asyncHandler(async (req, res, next) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return next(ApiError.unauthorized("Refresh token required"));
  }

  // Verify refresh token
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (error) {
    return next(ApiError.unauthorized("Invalid or expired refresh token"));
  }

  // Find user and verify stored refresh token
  const user = await User.findById(decoded.id).select("+refreshToken");

  if (!user || user.refreshToken !== refreshToken) {
    return next(ApiError.unauthorized("Invalid refresh token"));
  }

  if (!user.isActive) {
    return next(ApiError.unauthorized("User account is deactivated"));
  }

  // Generate new tokens
  const newAccessToken = generateAccessToken({ id: user._id, role: user.role });
  const newRefreshToken = generateRefreshToken({ id: user._id });

  // Update refresh token in database
  user.refreshToken = newRefreshToken;
  await user.save({ validateBeforeSave: false });

  successResponse(
    res,
    {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    },
    "Token refreshed successfully",
  );
});

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res, next) => {
  // End active session if present
  await UserSession.updateMany(
    { user: req.user._id, isActive: true },
    { isActive: false, logoutTime: new Date() },
  );

  // Clear refresh token from database
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

  // Log activity
  await ActivityLog.log({
    user: req.user._id,
    action: "logout",
    resourceType: "user",
    resourceId: req.user._id,
    description: `User logged out: ${req.user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`User logged out: ${req.user.email}`);

  successResponse(res, null, "Logged out successfully");
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user._id).populate("clientCount");

  successResponse(res, { user });
});

/**
 * @desc    Update current user profile
 * @route   PUT /api/auth/me
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res, next) => {
  const { name, phone, avatar } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { name, phone, avatar },
    { new: true, runValidators: true },
  );

  successResponse(res, { user }, "Profile updated successfully");
});

/**
 * @desc    Change password
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select("+password");

  // Check current password
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return next(ApiError.badRequest("Current password is incorrect"));
  }

  // Update password
  user.password = newPassword;
  user.refreshToken = null; // Invalidate all sessions
  await user.save();

  // Log activity
  await ActivityLog.log({
    user: user._id,
    action: "password_change",
    resourceType: "user",
    resourceId: user._id,
    description: `Password changed for: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Password changed for user: ${user.email}`);

  successResponse(
    res,
    null,
    "Password changed successfully. Please login again.",
  );
});

/**
 * @desc    Request password reset
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
const forgotPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    // Return success even if user doesn't exist (security)
    return successResponse(
      res,
      null,
      "If an account with that email exists, a reset link has been sent.",
    );
  }

  // Generate reset token
  const resetToken = generateRandomToken();
  user.passwordResetToken = hashToken(resetToken);
  user.passwordResetExpires = Date.now() + 30 * 60 * 1000; // 30 minutes
  await user.save({ validateBeforeSave: false });

  // In production, send email here
  // For now, just log it
  logger.info(`Password reset token for ${email}: ${resetToken}`);

  successResponse(
    res,
    null,
    "If an account with that email exists, a reset link has been sent.",
  );
});

/**
 * @desc    Public marketing manager registration
 * @route   POST /api/auth/register-marketing-manager
 * @access  Public
 */
const registerMarketingManager = asyncHandler(async (req, res, next) => {
  const { name, email, password, phone } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(ApiError.conflict("User with this email already exists"));
  }

  const user = await User.create({
    name,
    email,
    password,
    phone,
    role: "marketing",
    isActive: true,
  });

  await ActivityLog.log({
    user: user._id,
    action: "user_create",
    resourceType: "user",
    resourceId: user._id,
    description: `Marketing manager registered: ${user.email}`,
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
        avatar: user.avatar,
      },
    },
    "Marketing manager registered successfully",
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

  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(ApiError.badRequest("Invalid or expired reset token"));
  }

  // Update password
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshToken = null;
  await user.save();

  // Log activity
  await ActivityLog.log({
    user: user._id,
    action: "password_reset",
    resourceType: "user",
    resourceId: user._id,
    description: `Password reset for: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Password reset completed for: ${user.email}`);

  successResponse(
    res,
    null,
    "Password reset successful. Please login with your new password.",
  );
});

export {
  login,
  refreshAccessToken,
  logout,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  registerMarketingManager,
};
