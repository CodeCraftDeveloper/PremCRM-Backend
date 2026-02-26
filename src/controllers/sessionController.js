import { User, UserSession, Client } from "../models/index.js";
import logger from "../utils/logger.js";

const getStartOfDay = (value = new Date()) => {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
};

const formatDayKey = (value) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const getMergedOnlineSeconds = (
  sessions,
  { now = new Date(), startBoundary = null, endBoundary = null } = {},
) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;

  const nowMs = new Date(now).getTime();
  const startMs = startBoundary ? new Date(startBoundary).getTime() : null;
  const endMs = endBoundary ? new Date(endBoundary).getTime() : null;

  const intervals = sessions
    .map((session) => {
      let start = new Date(session.loginTime).getTime();
      let end = session.logoutTime
        ? new Date(session.logoutTime).getTime()
        : nowMs;

      if (startMs !== null) start = Math.max(start, startMs);
      if (endMs !== null) end = Math.min(end, endMs);
      if (end <= start) return null;

      return [start, end];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  if (intervals.length === 0) return 0;

  let totalMs = 0;
  let [currentStart, currentEnd] = intervals[0];

  for (let i = 1; i < intervals.length; i += 1) {
    const [nextStart, nextEnd] = intervals[i];
    if (nextStart <= currentEnd) {
      currentEnd = Math.max(currentEnd, nextEnd);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = nextStart;
      currentEnd = nextEnd;
    }
  }

  totalMs += currentEnd - currentStart;
  return Math.floor(totalMs / 1000);
};

/**
 * Track user login
 */
export const trackLogin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const ipAddress = req.ip;
    const userAgent = req.get("user-agent");

    // End any existing active sessions (in case user logs in from multiple places)
    await UserSession.updateMany(
      { user: userId, isActive: true },
      {
        isActive: false,
        logoutTime: new Date(),
      },
    );

    // Create new session
    const session = new UserSession({
      tenantId: req.user.tenantId,
      user: userId,
      loginTime: new Date(),
      isActive: true,
      ipAddress,
      userAgent,
    });

    await session.save();
    logger.info(`User ${userId} logged in. Session: ${session._id}`);

    next();
  } catch (error) {
    logger.error(`Error tracking login: ${error.message}`);
    next();
  }
};

/**
 * Track user logout
 */
export const trackLogout = async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return next();
    }

    // End active session
    const session = await UserSession.findOneAndUpdate(
      { user: userId, tenantId: req.user.tenantId, isActive: true },
      {
        isActive: false,
        logoutTime: new Date(),
      },
      { new: true },
    );

    if (session) {
      logger.info(
        `User ${userId} logged out. Session duration: ${session.duration}s`,
      );
    }

    next();
  } catch (error) {
    logger.error(`Error tracking logout: ${error.message}`);
    next();
  }
};

/**
 * Get marketing user online status (Admin only)
 */
export const getMarketingUsersStatus = async (req, res) => {
  try {
    // Only admins can view this
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can view user status",
      });
    }

    // Get all marketing users with their current session info
    const marketingUsers = await User.find({
      role: "marketing",
      isActive: true,
      tenantId: req.user.tenantId,
    }).select("-password -refreshToken");

    const usersWithStatus = await Promise.all(
      marketingUsers.map(async (user) => {
        // Get current session
        const currentSession = await UserSession.findOne(
          { user: user._id, tenantId: req.user.tenantId, isActive: true },
          {},
          { sort: { loginTime: -1 } },
        );

        // Get today's sessions
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todaySessions = await UserSession.find({
          user: user._id,
          tenantId: req.user.tenantId,
          loginTime: { $gte: today },
        });

        // Calculate today's total online time (without overlap)
        const todayTotalSeconds = getMergedOnlineSeconds(todaySessions, {
          now: new Date(),
          startBoundary: today,
        });

        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const dailyContactedUsers = await Client.countDocuments({
          tenantId: req.user.tenantId,
          lastContactedBy: user._id,
          lastContactedDate: { $gte: today, $lt: tomorrow },
        });

        return {
          userId: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          isOnline: !!currentSession,
          lastLogin: currentSession?.loginTime || user.lastLogin,
          currentSessionDuration: currentSession
            ? Math.floor((new Date() - currentSession.loginTime) / 1000)
            : 0,
          todayTotalOnlineSeconds: todayTotalSeconds,
          todayTotalOnlineTime: formatDuration(todayTotalSeconds),
          sessionsToday: todaySessions.length,
          dailyContactedUsers,
        };
      }),
    );

    res.json({
      success: true,
      data: usersWithStatus,
      count: usersWithStatus.length,
    });
  } catch (error) {
    logger.error(`Error fetching user status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error fetching user status",
      error: error.message,
    });
  }
};

/**
 * Get marketing user performance metrics (Admin only)
 */
export const getMarketingPerformance = async (req, res) => {
  try {
    // Only admins can view this
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can view performance metrics",
      });
    }

    const { startDate, endDate, userId } = req.query;

    // Build date filter
    const dateFilter = {};
    if (startDate) {
      dateFilter.$gte = new Date(startDate);
    }
    if (endDate) {
      dateFilter.$lte = new Date(endDate);
    }

    // Build user filter
    const userFilter = {
      role: "marketing",
      isActive: true,
      tenantId: req.user.tenantId,
    };
    if (userId) {
      userFilter._id = userId;
    }

    const marketingUsers = await User.find(userFilter).select(
      "-password -refreshToken",
    );

    const performance = await Promise.all(
      marketingUsers.map(async (user) => {
        const now = new Date();
        const todayStart = getStartOfDay(now);
        const tomorrow = new Date(todayStart);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get sessions within date range
        const query = { user: user._id, tenantId: req.user.tenantId };
        if (Object.keys(dateFilter).length > 0) {
          query.loginTime = dateFilter;
        }

        const sessions = await UserSession.find(query);
        const activeSession = await UserSession.findOne(
          { user: user._id, tenantId: req.user.tenantId, isActive: true },
          {},
          { sort: { loginTime: -1 } },
        );
        const todaySessions = await UserSession.find({
          user: user._id,
          tenantId: req.user.tenantId,
          loginTime: { $gte: todayStart, $lt: tomorrow },
        });

        const todayTotalOnlineSeconds = getMergedOnlineSeconds(todaySessions, {
          now,
          startBoundary: todayStart,
          endBoundary: tomorrow,
        });

        // Calculate metrics
        const totalSessions = sessions.length;
        const totalOnlineSeconds = sessions.reduce((total, session) => {
          return total + (session.duration || 0);
        }, 0);

        // Get average session duration
        const sessionsWithDuration = sessions.filter((s) => s.duration > 0);
        const avgSessionDuration =
          sessionsWithDuration.length > 0
            ? Math.floor(
                sessionsWithDuration.reduce((sum, s) => sum + s.duration, 0) /
                  sessionsWithDuration.length,
              )
            : 0;

        // Get user's tickets and clients created in this period
        const ticketCount = 0;
        const clientCount = await Client.countDocuments({
          tenantId: req.user.tenantId,
          createdBy: user._id,
        });

        const rangeStart = Object.keys(dateFilter).length > 0
          ? new Date(dateFilter.$gte || new Date(0))
          : new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
        const rangeEnd = Object.keys(dateFilter).length > 0
          ? new Date(dateFilter.$lte || now)
          : now;
        const dayWiseFrom = getStartOfDay(rangeStart);
        const dayWiseTo = getStartOfDay(rangeEnd);

        const [sessionAgg, contactedAgg] = await Promise.all([
          UserSession.aggregate([
            {
              $match: {
                user: user._id,
                tenantId: req.user.tenantId,
                loginTime: { $gte: dayWiseFrom, $lte: rangeEnd },
              },
            },
            {
              $addFields: {
                effectiveDuration: {
                  $cond: [
                    "$isActive",
                    {
                      $divide: [{ $subtract: [now, "$loginTime"] }, 1000],
                    },
                    "$duration",
                  ],
                },
                day: {
                  $dateToString: { format: "%Y-%m-%d", date: "$loginTime" },
                },
              },
            },
            {
              $group: {
                _id: "$day",
                totalOnlineSeconds: { $sum: "$effectiveDuration" },
                sessions: { $sum: 1 },
              },
            },
          ]),
          Client.aggregate([
            {
              $match: {
                tenantId: req.user.tenantId,
                lastContactedBy: user._id,
                lastContactedDate: { $gte: dayWiseFrom, $lte: rangeEnd },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$lastContactedDate",
                  },
                },
                contactedUsers: { $sum: 1 },
              },
            },
          ]),
        ]);

        const sessionMap = new Map(
          sessionAgg.map((entry) => [
            entry._id,
            {
              totalOnlineSeconds: Math.max(0, Math.floor(entry.totalOnlineSeconds || 0)),
              sessions: entry.sessions || 0,
            },
          ]),
        );
        const contactedMap = new Map(
          contactedAgg.map((entry) => [entry._id, entry.contactedUsers || 0]),
        );

        const dayWiseStats = [];
        const cursor = new Date(dayWiseTo);
        for (let i = 0; i < 7; i += 1) {
          const day = new Date(cursor);
          day.setDate(cursor.getDate() - i);
          const key = formatDayKey(day);
          const sessionDay = sessionMap.get(key) || {
            totalOnlineSeconds: 0,
            sessions: 0,
          };
          dayWiseStats.push({
            date: key,
            status:
              key === formatDayKey(now) && activeSession ? "online" : "offline",
            sessions: sessionDay.sessions,
            totalOnlineSeconds: sessionDay.totalOnlineSeconds,
            totalOnlineTime: formatDuration(sessionDay.totalOnlineSeconds),
            contactedUsers: contactedMap.get(key) || 0,
          });
        }

        return {
          userId: user._id,
          name: user.name,
          email: user.email,
          isOnline: Boolean(activeSession),
          currentSessionDuration: activeSession
            ? Math.floor((now - activeSession.loginTime) / 1000)
            : 0,
          totalSessions,
          totalOnlineSeconds,
          totalOnlineTime: formatDuration(totalOnlineSeconds),
          avgSessionDuration: formatDuration(avgSessionDuration),
          avgSessionDurationSeconds: avgSessionDuration,
          todayTotalOnlineSeconds,
          todayTotalOnlineTime: formatDuration(todayTotalOnlineSeconds),
          todaySessions: todaySessions.length,
          dailyContactedUsers: contactedMap.get(formatDayKey(now)) || 0,
          dayWiseStats,
          sessionsPerDay:
            totalSessions > 0
              ? (
                  (totalSessions * 86400000) /
                  Math.max(1, rangeEnd.getTime() - rangeStart.getTime())
                ).toFixed(2)
              : 0,
          ticketsCreated: ticketCount,
          clientsCreated: clientCount,
        };
      }),
    );

    res.json({
      success: true,
      data: performance,
      count: performance.length,
      dateRange: {
        startDate: startDate || "All time",
        endDate: endDate || "Now",
      },
    });
  } catch (error) {
    logger.error(`Error fetching performance metrics: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error fetching performance metrics",
      error: error.message,
    });
  }
};

/**
 * Get current marketing user's own performance
 */
export const getMyMarketingPerformance = async (req, res) => {
  try {
    if (req.user.role !== "marketing") {
      return res.status(403).json({
        success: false,
        message: "Only marketing users can view this",
      });
    }

    const { startDate, endDate } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const user = await User.findById(req.user._id).select("-password -refreshToken");
    if (!user || !user.isActive || user.role !== "marketing") {
      return res.status(404).json({
        success: false,
        message: "Marketing user not found",
      });
    }

    const now = new Date();
    const todayStart = getStartOfDay(now);
    const tomorrow = new Date(todayStart);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = { user: user._id, tenantId: req.user.tenantId };
    if (Object.keys(dateFilter).length > 0) {
      query.loginTime = dateFilter;
    }

    const sessions = await UserSession.find(query);
    const activeSession = await UserSession.findOne(
      { user: user._id, tenantId: req.user.tenantId, isActive: true },
      {},
      { sort: { loginTime: -1 } },
    );
    const todaySessions = await UserSession.find({
      user: user._id,
      tenantId: req.user.tenantId,
      loginTime: { $gte: todayStart, $lt: tomorrow },
    });

    const todayTotalOnlineSeconds = getMergedOnlineSeconds(todaySessions, {
      now,
      startBoundary: todayStart,
      endBoundary: tomorrow,
    });

    const totalSessions = sessions.length;
    const totalOnlineSeconds = sessions.reduce((total, session) => {
      return total + (session.duration || 0);
    }, 0);

    const sessionsWithDuration = sessions.filter((s) => s.duration > 0);
    const avgSessionDuration =
      sessionsWithDuration.length > 0
        ? Math.floor(
            sessionsWithDuration.reduce((sum, s) => sum + s.duration, 0) /
              sessionsWithDuration.length,
          )
        : 0;

    const ticketCount = 0;
    const clientCount = await Client.countDocuments({
      tenantId: req.user.tenantId,
      createdBy: user._id,
    });

    const rangeStart = Object.keys(dateFilter).length > 0
      ? new Date(dateFilter.$gte || new Date(0))
      : new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
    const rangeEnd = Object.keys(dateFilter).length > 0
      ? new Date(dateFilter.$lte || now)
      : now;
    const dayWiseFrom = getStartOfDay(rangeStart);
    const dayWiseTo = getStartOfDay(rangeEnd);

    const [sessionAgg, contactedAgg] = await Promise.all([
      UserSession.aggregate([
        {
          $match: {
            user: user._id,
            tenantId: req.user.tenantId,
            loginTime: { $gte: dayWiseFrom, $lte: rangeEnd },
          },
        },
        {
          $addFields: {
            effectiveDuration: {
              $cond: [
                "$isActive",
                {
                  $divide: [{ $subtract: [now, "$loginTime"] }, 1000],
                },
                "$duration",
              ],
            },
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$loginTime" },
            },
          },
        },
        {
          $group: {
            _id: "$day",
            totalOnlineSeconds: { $sum: "$effectiveDuration" },
            sessions: { $sum: 1 },
          },
        },
      ]),
      Client.aggregate([
        {
          $match: {
            tenantId: req.user.tenantId,
            lastContactedBy: user._id,
            lastContactedDate: { $gte: dayWiseFrom, $lte: rangeEnd },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$lastContactedDate",
              },
            },
            contactedUsers: { $sum: 1 },
          },
        },
      ]),
    ]);

    const sessionMap = new Map(
      sessionAgg.map((entry) => [
        entry._id,
        {
          totalOnlineSeconds: Math.max(0, Math.floor(entry.totalOnlineSeconds || 0)),
          sessions: entry.sessions || 0,
        },
      ]),
    );
    const contactedMap = new Map(
      contactedAgg.map((entry) => [entry._id, entry.contactedUsers || 0]),
    );

    const dayWiseStats = [];
    const cursor = new Date(dayWiseTo);
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(cursor);
      day.setDate(cursor.getDate() - i);
      const key = formatDayKey(day);
      const sessionDay = sessionMap.get(key) || {
        totalOnlineSeconds: 0,
        sessions: 0,
      };
      dayWiseStats.push({
        date: key,
        status: key === formatDayKey(now) && activeSession ? "online" : "offline",
        sessions: sessionDay.sessions,
        totalOnlineSeconds: sessionDay.totalOnlineSeconds,
        totalOnlineTime: formatDuration(sessionDay.totalOnlineSeconds),
        contactedUsers: contactedMap.get(key) || 0,
      });
    }

    res.json({
      success: true,
      data: {
        userId: user._id,
        name: user.name,
        email: user.email,
        isOnline: Boolean(activeSession),
        currentSessionDuration: activeSession
          ? Math.floor((now - activeSession.loginTime) / 1000)
          : 0,
        totalSessions,
        totalOnlineSeconds,
        totalOnlineTime: formatDuration(totalOnlineSeconds),
        avgSessionDuration: formatDuration(avgSessionDuration),
        avgSessionDurationSeconds: avgSessionDuration,
        todayTotalOnlineSeconds,
        todayTotalOnlineTime: formatDuration(todayTotalOnlineSeconds),
        todaySessions: todaySessions.length,
        dailyContactedUsers: contactedMap.get(formatDayKey(now)) || 0,
        dayWiseStats,
        sessionsPerDay:
          totalSessions > 0
            ? (
                (totalSessions * 86400000) /
                Math.max(1, rangeEnd.getTime() - rangeStart.getTime())
              ).toFixed(2)
            : 0,
        ticketsCreated: ticketCount,
        clientsCreated: clientCount,
      },
    });
  } catch (error) {
    logger.error(`Error fetching own performance metrics: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error fetching own performance metrics",
      error: error.message,
    });
  }
};

/**
 * Get marketing user detailed report (Admin only)
 */
export const getMarketingUserDetailedReport = async (req, res) => {
  try {
    // Only admins can view this
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can view user reports",
      });
    }

    const { userId } = req.params;
    const { days = 30 } = req.query;

    // Get user
    const user = await User.findOne({
      _id: userId,
      tenantId: req.user.tenantId,
      role: "marketing",
    }).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Marketing user not found",
      });
    }

    // Get sessions from last N days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const sessions = await UserSession.find({
      user: userId,
      tenantId: req.user.tenantId,
      loginTime: { $gte: startDate },
    }).sort({ loginTime: -1 });

    const activeSession = await UserSession.findOne(
      { user: userId, tenantId: req.user.tenantId, isActive: true },
      {},
      { sort: { loginTime: -1 } },
    );

    const contactedAgg = await Client.aggregate([
      {
        $match: {
          tenantId: req.user.tenantId,
          lastContactedBy: user._id,
          lastContactedDate: { $gte: startDate, $lte: new Date() },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$lastContactedDate" },
          },
          contactedUsers: { $sum: 1 },
        },
      },
    ]);
    const contactedMap = new Map(
      contactedAgg.map((entry) => [entry._id, entry.contactedUsers || 0]),
    );

    // Get daily breakdown
    const dailyStats = {};
    sessions.forEach((session) => {
      const date = new Date(session.loginTime).toISOString().split("T")[0];
      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          sessions: 0,
          totalSeconds: 0,
          totalTime: "",
          contactedUsers: 0,
          status: "offline",
        };
      }
      dailyStats[date].sessions += 1;
      dailyStats[date].totalSeconds += session.duration || 0;
      dailyStats[date].totalTime = formatDuration(
        dailyStats[date].totalSeconds,
      );
      dailyStats[date].contactedUsers = contactedMap.get(date) || 0;
      dailyStats[date].status =
        date === formatDayKey(new Date()) && activeSession ? "online" : "offline";
    });

    contactedMap.forEach((contactedUsers, date) => {
      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          sessions: 0,
          totalSeconds: 0,
          totalTime: formatDuration(0),
          contactedUsers,
          status:
            date === formatDayKey(new Date()) && activeSession ? "online" : "offline",
        };
      }
    });

    // Calculate overall metrics
    const totalSessions = sessions.length;
    const totalOnlineSeconds = sessions.reduce(
      (sum, s) => sum + (s.duration || 0),
      0,
    );
    const avgSessionDuration =
      totalSessions > 0 ? Math.floor(totalOnlineSeconds / totalSessions) : 0;

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          createdAt: user.createdAt,
        },
        reportPeriod: {
          days,
          startDate: startDate.toISOString(),
          endDate: new Date().toISOString(),
        },
        metrics: {
          totalSessions,
          totalOnlineSeconds,
          totalOnlineTime: formatDuration(totalOnlineSeconds),
          avgSessionDuration: formatDuration(avgSessionDuration),
          avgSessionDurationSeconds: avgSessionDuration,
        },
        dailyBreakdown: Object.values(dailyStats).sort(
          (a, b) => new Date(b.date) - new Date(a.date),
        ),
        recentSessions: sessions.slice(0, 10).map((s) => ({
          loginTime: s.loginTime,
          logoutTime: s.logoutTime,
          duration: s.duration,
          durationFormatted: formatDuration(s.duration),
          isActive: s.isActive,
          ipAddress: s.ipAddress,
        })),
      },
    });
  } catch (error) {
    logger.error(`Error fetching detailed report: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error fetching detailed report",
      error: error.message,
    });
  }
};

/**
 * Helper function to format duration
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "0s";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}
