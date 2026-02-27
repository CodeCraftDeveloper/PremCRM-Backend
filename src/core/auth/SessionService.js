import UserSession from "../../models/UserSession.js";
import User from "../../models/User.js";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import mongoose from "mongoose";

/**
 * SessionService
 * Handles all session lifecycle management
 * CRITICAL: Duration calculation happens in endSession(), NOT in hooks
 */
class SessionService {
  /**
   * Create a new session
   * @param {String} userId - User ID
   * @param {Object} metadata - Device, IP, userAgent, etc.
   * @returns {Object} Created session
   */
  static async createSession(userId, metadata = {}) {
    try {
      let tenantId = metadata.tenantId;

      if (!tenantId) {
        const user = await User.findById(userId).select("tenantId").lean();
        tenantId = user?.tenantId;
      }

      if (!tenantId) {
        throw new Error("Cannot create session: tenantId is missing for user");
      }

      const session = await UserSession.create({
        user: userId,
        tenantId,
        loginTime: new Date(),
        isActive: true,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        device: metadata.device,
        clientSessionId: metadata.clientSessionId || null,
      });

      // Cache active sessions list (5 min TTL)
      await redis.sadd(`user:${userId}:activeSessions`, session._id.toString());
      await redis.expire(`user:${userId}:activeSessions`, 300);

      // Cache individual session (24 hour TTL)
      await redis.setex(
        `session:${session._id}`,
        86400,
        JSON.stringify({
          id: session._id,
          userId,
          loginTime: session.loginTime,
          isActive: true,
        }),
      );

      logger.info(`Session created: ${session._id} for user: ${userId}`);
      return session;
    } catch (error) {
      logger.error(`Error creating session: ${error.message}`);
      throw error;
    }
  }

  /**
   * End session (logout)
   * CRITICAL: Duration calculated HERE, NOT in pre-save hook
   * Ensures logged-out sessions always have duration
   * @param {String} sessionId - Session ID
   * @param {String} tenantId - Tenant ID
   * @returns {Object} Updated session with duration
   */
  static async endSession(sessionId, tenantId) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      const session = await UserSession.findOne({ _id: sessionId, tenantId });

      if (!session) {
        throw new Error("Session not found");
      }

      const logoutTime = new Date();
      const durationSeconds = Math.floor(
        (logoutTime - session.loginTime) / 1000,
      );

      // Update session with duration BEFORE saving
      const updatedSession = await UserSession.findOneAndUpdate(
        { _id: sessionId, tenantId },
        {
          isActive: false,
          logoutTime,
          duration: durationSeconds, // CALCULATE HERE
        },
        { new: true },
      );

      // Remove from active sessions cache
      await redis.srem(
        `user:${session.user}:activeSessions`,
        sessionId.toString(),
      );

      // Clear session cache
      await redis.del(`session:${sessionId}`);

      logger.info(`Session ended: ${sessionId}, duration: ${durationSeconds}s`);
      return updatedSession;
    } catch (error) {
      logger.error(`Error ending session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user's active sessions with caching
   * @param {String} userId - User ID
   * @returns {Array} Active sessions
   */
  static async getUserActiveSessions(userId, tenantId) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      // Try cache first
      const cached = await redis.smembers(`user:${userId}:activeSessions`);
      if (cached.length > 0) {
        return await UserSession.find({
          _id: { $in: cached },
          isActive: true,
          tenantId,
        });
      }

      const sessions = await UserSession.find({
        user: userId,
        isActive: true,
        tenantId,
      }).sort({ loginTime: -1 });

      if (sessions.length > 0) {
        const sessionIds = sessions.map((s) => s._id.toString());
        await redis.sadd(`user:${userId}:activeSessions`, ...sessionIds);
        await redis.expire(`user:${userId}:activeSessions`, 300);
      }

      return sessions;
    } catch (error) {
      logger.error(`Error getting active sessions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Force logout all sessions (password change, security incident)
   * @param {String} userId - User ID
   * @param {String} tenantId - Tenant ID
   */
  static async forceLogoutAllSessions(userId, tenantId) {
    try {
      const now = new Date();
      const activeSessions = await UserSession.find({
        user: userId,
        tenantId,
        isActive: true,
      }).select("_id loginTime");

      if (activeSessions.length > 0) {
        const updates = activeSessions.map((session) => {
          const duration = Math.max(
            0,
            Math.floor(
              (now.getTime() - new Date(session.loginTime).getTime()) / 1000,
            ),
          );
          return {
            updateOne: {
              filter: { _id: session._id },
              update: {
                $set: {
                  isActive: false,
                  logoutTime: now,
                  duration,
                },
              },
            },
          };
        });
        await UserSession.bulkWrite(updates);
      }

      // Clear all caches for this user
      await redis.del(`user:${userId}:activeSessions`);
      const sessionKeys = activeSessions.map(
        (session) => `session:${session._id}`,
      );
      if (sessionKeys.length > 0) {
        await redis.del(...sessionKeys);
      }

      logger.warn(`All sessions force-logged out for user: ${userId}`);
    } catch (error) {
      logger.error(`Error force logging out sessions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get session metrics for dashboard
   * Uses aggregation (no N+1 queries)
   * @param {String} userId - User ID
   * @param {Object} dateRange - {start, end}
   * @returns {Object} Session metrics
   */
  static async getSessionMetrics(userId, tenantId, dateRange = {}) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      const matchStage = {
        user: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(tenantId),
      };

      if (dateRange.start || dateRange.end) {
        matchStage.loginTime = {};
        if (dateRange.start) matchStage.loginTime.$gte = dateRange.start;
        if (dateRange.end) matchStage.loginTime.$lte = dateRange.end;
      }

      const metrics = await UserSession.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalSessions: { $sum: 1 },
            activeSessions: {
              $sum: { $cond: ["$isActive", 1, 0] },
            },
            avgDuration: { $avg: "$duration" },
            totalDuration: { $sum: "$duration" },
            minDuration: { $min: "$duration" },
            maxDuration: { $max: "$duration" },
          },
        },
        {
          $project: {
            _id: 0,
            totalSessions: 1,
            activeSessions: 1,
            avgDuration: { $round: ["$avgDuration", 0] },
            totalDuration: 1,
            minDuration: 1,
            maxDuration: 1,
          },
        },
      ]);

      return metrics.length > 0
        ? metrics[0]
        : {
            totalSessions: 0,
            activeSessions: 0,
            avgDuration: 0,
            totalDuration: 0,
            minDuration: 0,
            maxDuration: 0,
          };
    } catch (error) {
      logger.error(`Error getting session metrics: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get sessions per day for analytics
   * @param {String} tenantId - Tenant ID
   * @param {Number} days - Number of days back
   * @returns {Array} Daily session stats
   */
  static async getSessionsPerDay(tenantId, days = 7) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const stats = await UserSession.aggregate([
        {
          $match: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            loginTime: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$loginTime" },
            },
            count: { $sum: 1 },
            avgDuration: { $avg: "$duration" },
            totalDuration: { $sum: "$duration" },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      return stats;
    } catch (error) {
      logger.error(`Error getting sessions per day: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cleanup stale sessions (>24hr inactive)
   * Background job
   * @param {Number} maxInactivityHours - Hours of inactivity before cleanup
   */
  static async cleanupStaleSessions(maxInactivityHours = 24) {
    try {
      const cutoffTime = new Date(
        Date.now() - maxInactivityHours * 60 * 60 * 1000,
      );

      const result = await UserSession.updateMany(
        {
          isActive: false,
          logoutTime: { $lt: cutoffTime },
        },
        {
          $set: { isActive: false },
        },
      );

      logger.info(
        `Cleanup: Marked ${result.modifiedCount} stale sessions as inactive`,
      );
      return result;
    } catch (error) {
      logger.error(`Error cleaning up stale sessions: ${error.message}`);
      throw error;
    }
  }
}

export default SessionService;
