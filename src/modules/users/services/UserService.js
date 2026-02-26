import User from "../../models/User.js";
import logger from "../../utils/logger.js";

/**
 * UserService
 * User CRUD with aggregation-based queries (no N+1)
 */
class UserService {
  /**
   * Get user with metrics (no N+1 queries)
   * Uses aggregation pipeline
   * @param {String} userId - User ID
   * @param {String} tenantId - Tenant ID
   * @returns {Object} User with metrics
   */
  static async getUserWithMetrics(userId, tenantId) {
    try {
      const ObjectId = require("mongodb").ObjectId;

      const user = await User.aggregate([
        {
          $match: {
            _id: new ObjectId(userId),
            tenantId: new ObjectId(tenantId),
          },
        },
        {
          $lookup: {
            from: "usersessions",
            localField: "_id",
            foreignField: "user",
            as: "sessions",
          },
        },
        {
          $addFields: {
            totalSessions: { $size: "$sessions" },
            activeSessions: {
              $size: {
                $filter: {
                  input: "$sessions",
                  as: "session",
                  cond: { $eq: ["$$session.isActive", true] },
                },
              },
            },
            avgSessionDuration: {
              $avg: {
                $filter: {
                  input: "$sessions",
                  as: "session",
                  cond: { $gt: ["$$session.duration", 0] },
                },
              },
            },
          },
        },
        {
          $project: {
            password: 0,
            refreshToken: 0,
            sessions: 0,
          },
        },
      ]);

      return user.length > 0 ? user[0] : null;
    } catch (error) {
      logger.error(`Error getting user with metrics: ${error.message}`);
      throw error;
    }
  }

  /**
   * List users with filters (aggregation-based)
   * @param {String} tenantId - Tenant ID
   * @param {Object} options - {role, status, search, limit, skip}
   * @returns {Array} Users
   */
  static async listUsers(tenantId, options = {}) {
    try {
      const ObjectId = require("mongodb").ObjectId;
      const { role, status, search, limit = 10, skip = 0 } = options;

      const matchStage = { tenantId: new ObjectId(tenantId) };

      if (role) matchStage.role = role;
      if (status === "active") matchStage.isActive = true;
      if (status === "inactive") matchStage.isActive = false;

      const pipeline = [{ $match: matchStage }];

      // Search filter
      if (search) {
        pipeline.push({
          $match: {
            $or: [
              { name: { $regex: search, $options: "i" } },
              { email: { $regex: search, $options: "i" } },
            ],
          },
        });
      }

      // Aggregation with session metrics
      pipeline.push(
        {
          $lookup: {
            from: "usersessions",
            localField: "_id",
            foreignField: "user",
            as: "sessions",
          },
        },
        {
          $addFields: {
            totalSessions: { $size: "$sessions" },
            activeSessions: {
              $size: {
                $filter: {
                  input: "$sessions",
                  as: "session",
                  cond: { $eq: ["$$session.isActive", true] },
                },
              },
            },
          },
        },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            password: 0,
            refreshToken: 0,
            sessions: 0,
          },
        },
      );

      return await User.aggregate(pipeline);
    } catch (error) {
      logger.error(`Error listing users: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create user
   * @param {Object} data -  User data
   * @returns {Object} Created user
   */
  static async createUser(data) {
    try {
      const user = await User.create(data);
      logger.info(`User created: ${user._id}`);
      return user;
    } catch (error) {
      if (error.code === 11000) {
        throw new Error("Email already exists");
      }
      logger.error(`Error creating user: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update user profile
   * Whitelist-based updates (security)
   * @param {String} userId - User ID
   * @param {Object} data - Update data
   * @returns {Object} Updated user
   */
  static async updateUserProfile(userId, data) {
    try {
      // Whitelist allowed fields
      const allowedFields = ["name", "phone", "avatar", "email"];
      const updateData = {};

      allowedFields.forEach((field) => {
        if (data[field] !== undefined) {
          updateData[field] = data[field];
        }
      });

      const user = await User.findByIdAndUpdate(userId, updateData, {
        new: true,
        runValidators: true,
      });

      logger.info(`User profile updated: ${userId}`);
      return user;
    } catch (error) {
      logger.error(`Error updating user profile: ${error.message}`);
      throw error;
    }
  }

  /**
   * Change password
   * @param {String} userId - User ID
   * @param {String} currentPassword - Current password
   * @param {String} newPassword - New password
   */
  static async changePassword(userId, currentPassword, newPassword) {
    try {
      const user = await User.findById(userId).select("+password");

      if (!user) {
        throw new Error("User not found");
      }

      // Verify current password
      const isValid = await user.comparePassword(currentPassword);
      if (!isValid) {
        throw new Error("Current password is incorrect");
      }

      // Update password and logout all sessions
      user.password = newPassword;
      user.refreshToken = null;
      await user.save();

      logger.info(`Password changed for user: ${userId}`);
    } catch (error) {
      logger.error(`Error changing password: ${error.message}`);
      throw error;
    }
  }

  /**
   * Set user active/inactive status
   * @param {String} userId - User ID
   * @param {Boolean} isActive - Status
   */
  static async setUserStatus(userId, isActive) {
    try {
      const user = await User.findByIdAndUpdate(
        userId,
        { isActive },
        { new: true },
      );

      logger.info(`User status updated: ${userId}, isActive: ${isActive}`);
      return user;
    } catch (error) {
      logger.error(`Error setting user status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user statistics for tenant (aggregation)
   * @param {String} tenantId - Tenant ID
   * @returns {Object} Statistics
   */
  static async getUserStatistics(tenantId) {
    try {
      const ObjectId = require("mongodb").ObjectId;

      const stats = await User.aggregate([
        { $match: { tenantId: new ObjectId(tenantId) } },
        {
          $facet: {
            byRole: [{ $group: { _id: "$role", count: { $sum: 1 } } }],
            byStatus: [
              {
                $group: {
                  _id: "$isActive",
                  count: { $sum: 1 },
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);

      return stats.length > 0
        ? stats[0]
        : { byRole: [], byStatus: [], total: [{ count: 0 }] };
    } catch (error) {
      logger.error(`Error getting user statistics: ${error.message}`);
      throw error;
    }
  }
}

export default UserService;
