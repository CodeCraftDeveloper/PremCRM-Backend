import User from "../models/User.js";
import Client from "../models/Client.js";
import ActivityLog from "../models/ActivityLog.js";
import Tenant from "../models/Tenant.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import { deleteCachePattern } from "../config/redis.js";
import logger from "../utils/logger.js";

const PLATFORM_TENANT_SLUG = "__platform__";

const isTenantActiveUser = (user) =>
  Boolean(user?.isActive) && user?.approvalStatus !== "rejected";

const isPlatformOwnerUser = async (user) => {
  if (!user || user.role !== "superadmin") return false;
  const tenant = await Tenant.findById(user.tenantId).select("slug").lean();
  return tenant?.slug === PLATFORM_TENANT_SLUG;
};

const adjustTenantActiveUsers = async (tenantId, delta = 0) => {
  if (!tenantId || !delta) return;
  await Tenant.findByIdAndUpdate(tenantId, {
    $inc: { activeUsers: delta },
  });
};

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
const getUsers = asyncHandler(async (req, res, next) => {
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    sortOrder = "desc",
    role,
    isActive,
    search,
    approvalStatus,
  } = req.query;

  // Build query
  const query = { tenantId: req.user.tenantId };

  if (role) query.role = role;
  if (isActive === "true" || isActive === "false") {
    query.isActive = isActive === "true";
  }
  if (approvalStatus) query.approvalStatus = approvalStatus;
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortOptions = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  // Execute query
  const [users, totalDocs] = await Promise.all([
    User.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("clientCount"),
    User.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / parseInt(limit));

  paginatedResponse(res, users, {
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages,
    totalDocs,
  });
});

/**
 * @desc    Get single user
 * @route   GET /api/users/:id
 * @access  Private/Admin
 */
const getUser = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  }).populate("clientCount");

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  // Get user's recent activity
  const recentActivity = await ActivityLog.find({
    tenantId: req.user.tenantId,
    user: user._id,
  })
    .sort({ createdAt: -1 })
    .limit(10);

  // Get user's client statistics
  const clientStats = await Client.getStats({ marketingPerson: user._id });

  successResponse(res, { user, recentActivity, clientStats });
});

/**
 * @desc    Create user
 * @route   POST /api/users
 * @access  Private/Admin
 */
const createUser = asyncHandler(async (req, res, next) => {
  const { name, email, password, role, phone, isActive } = req.body;

  if (role === "superadmin") {
    return next(
      ApiError.forbidden(
        "Creating superadmin users is not allowed from this endpoint",
      ),
    );
  }

  // Check if user exists
  const existingUser = await User.findOne({
    tenantId: req.user.tenantId,
    email,
  });
  if (existingUser) {
    return next(ApiError.conflict("User with this email already exists"));
  }

  // Create user
  const user = await User.create({
    tenantId: req.user.tenantId,
    name,
    email,
    password,
    role: role || "marketing",
    phone,
    isActive: isActive !== undefined ? isActive : true,
    createdBy: req.user._id,
  });

  if (isTenantActiveUser(user)) {
    await adjustTenantActiveUsers(req.user.tenantId, 1);
  }

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "user_create",
    resourceType: "user",
    resourceId: user._id,
    description: `Created user: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("users:*");

  logger.info(`User created: ${user.email} by ${req.user.email}`);

  successResponse(res, { user }, "User created successfully", 201);
});

/**
 * @desc    Update user
 * @route   PUT /api/users/:id
 * @access  Private/Admin
 */
const updateUser = asyncHandler(async (req, res, next) => {
  const { name, email, role, phone, isActive } = req.body;

  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  const wasTenantActive = isTenantActiveUser(user);

  // Prevent admin from changing their own role
  if (
    req.params.id === req.user._id.toString() &&
    role &&
    role !== req.user.role
  ) {
    return next(ApiError.forbidden("You cannot change your own role"));
  }

  // Check email uniqueness if email is being changed
  if (email && email !== user.email) {
    const existingUser = await User.findOne({
      tenantId: req.user.tenantId,
      email,
      _id: { $ne: req.params.id },
    });
    if (existingUser) {
      return next(ApiError.conflict("Email is already in use"));
    }
  }

  // Update user
  const updatedUser = await User.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.user.tenantId },
    { name, email, role, phone, isActive },
    { new: true, runValidators: true },
  );

  const isTenantActiveNow = isTenantActiveUser(updatedUser);
  if (wasTenantActive !== isTenantActiveNow) {
    await adjustTenantActiveUsers(
      req.user.tenantId,
      isTenantActiveNow ? 1 : -1,
    );
  }

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "user_update",
    resourceType: "user",
    resourceId: updatedUser._id,
    description: `Updated user: ${updatedUser.email}`,
    metadata: { changes: { name, email, role, phone, isActive } },
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("users:*");

  logger.info(`User updated: ${updatedUser.email} by ${req.user.email}`);

  successResponse(res, { user: updatedUser }, "User updated successfully");
});

/**
 * @desc    Delete user (soft delete)
 * @route   DELETE /api/users/:id
 * @access  Private/Admin
 */
const deleteUser = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  // Prevent self-deletion
  if (req.params.id === req.user._id.toString()) {
    return next(ApiError.forbidden("You cannot delete your own account"));
  }

  // Check if user has clients
  const clientCount = await Client.countDocuments({
    marketingPerson: user._id,
  });
  if (clientCount > 0) {
    return next(
      ApiError.badRequest(
        `Cannot delete user with ${clientCount} assigned clients. Reassign clients first.`,
      ),
    );
  }

  // Soft delete - just deactivate
  const wasTenantActive = isTenantActiveUser(user);
  user.isActive = false;
  user.refreshToken = null;
  await user.save();

  if (wasTenantActive) {
    await adjustTenantActiveUsers(req.user.tenantId, -1);
  }

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "user_delete",
    resourceType: "user",
    resourceId: user._id,
    description: `Deleted (deactivated) user: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Clear cache
  await deleteCachePattern("users:*");

  logger.info(`User deleted: ${user.email} by ${req.user.email}`);

  successResponse(res, null, "User deleted successfully");
});

/**
 * @desc    Reset user password (by admin)
 * @route   PUT /api/users/:id/reset-password
 * @access  Private/Admin
 */
const resetUserPassword = asyncHandler(async (req, res, next) => {
  const { newPassword } = req.body;

  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  user.password = newPassword;
  user.refreshToken = null; // Invalidate all sessions
  await user.save();

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "password_reset",
    resourceType: "user",
    resourceId: user._id,
    description: `Admin reset password for: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Password reset by admin for: ${user.email}`);

  successResponse(res, null, "Password reset successfully");
});

/**
 * @desc    Get marketing users (for dropdowns)
 * @route   GET /api/users/marketing
 * @access  Private
 */
const getMarketingUsers = asyncHandler(async (req, res, next) => {
  const users = await User.find({
    tenantId: req.user.tenantId,
    role: "marketing",
    isActive: true,
  })
    .select("name email avatar")
    .sort({ name: 1 });

  successResponse(res, { users });
});

/**
 * @desc    Approve pending user registration
 * @route   PUT /api/users/:id/approve
 * @access  Private/Admin
 */
const approveUser = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  if (user.approvalStatus !== "pending") {
    return next(
      ApiError.badRequest(
        `User is already ${user.approvalStatus}. Cannot approve.`,
      ),
    );
  }

  const wasTenantActive = isTenantActiveUser(user);
  user.approvalStatus = "approved";
  user.isActive = true;
  user.approvedBy = req.user._id;
  user.approvedAt = new Date();
  await user.save({ validateBeforeSave: false });

  const isTenantActiveNow = isTenantActiveUser(user);
  if (!wasTenantActive && isTenantActiveNow) {
    await adjustTenantActiveUsers(user.tenantId, 1);
  }

  // Log activity
  await ActivityLog.log({
    tenantId: user.tenantId,
    user: req.user._id,
    action: "user_approve",
    resourceType: "user",
    resourceId: user._id,
    description: `Approved user registration: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  await deleteCachePattern("users:*");

  logger.info(`User approved: ${user.email} by ${req.user.email}`);

  successResponse(res, { user }, "User approved successfully");
});

/**
 * @desc    Reject pending user registration
 * @route   PUT /api/users/:id/reject
 * @access  Private/Admin
 */
const rejectUser = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId,
  });

  if (!user) {
    return next(ApiError.notFound("User not found"));
  }

  if (user.approvalStatus !== "pending") {
    return next(
      ApiError.badRequest(
        `User is already ${user.approvalStatus}. Cannot reject.`,
      ),
    );
  }

  const wasTenantActive = isTenantActiveUser(user);
  user.approvalStatus = "rejected";
  user.isActive = false;
  await user.save({ validateBeforeSave: false });

  if (wasTenantActive) {
    await adjustTenantActiveUsers(user.tenantId, -1);
  }

  // Log activity
  await ActivityLog.log({
    tenantId: user.tenantId,
    user: req.user._id,
    action: "user_reject",
    resourceType: "user",
    resourceId: user._id,
    description: `Rejected user registration: ${user.email}`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  await deleteCachePattern("users:*");

  logger.info(`User rejected: ${user.email} by ${req.user.email}`);

  successResponse(res, { user }, "User registration rejected");
});

/**
 * @desc    Get pending approval users
 * @route   GET /api/users/pending-approvals
 * @access  Private/Admin
 */
const getPendingApprovals = asyncHandler(async (req, res, next) => {
  const users = await User.find({
    tenantId: req.user.tenantId,
    approvalStatus: "pending",
  })
    .sort({ createdAt: -1 })
    .select("name email phone role createdAt tenantId");

  successResponse(res, { users, count: users.length });
});

export {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  getMarketingUsers,
  approveUser,
  rejectUser,
  getPendingApprovals,
};
