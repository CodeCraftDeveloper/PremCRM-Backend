import { Server } from "socket.io";
import User from "../models/User.js";
import UserSession from "../models/UserSession.js";
import { verifyAccessToken } from "../utils/jwt.js";
import logger from "../utils/logger.js";

let io = null;
const pendingDisconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 45000;

const getTokenFromSocket = (socket) => {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;

  const header = socket.handshake.headers?.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.split(" ")[1];
  }

  const cookieHeader = socket.handshake.headers?.cookie;
  if (cookieHeader) {
    const tokenCookie = cookieHeader
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("accessToken="));
    if (tokenCookie) {
      try {
        return decodeURIComponent(tokenCookie.split("=")[1] || "");
      } catch {
        return tokenCookie.split("=")[1] || "";
      }
    }
  }

  return null;
};

const getClientSessionIdFromSocket = (socket) => {
  const authSessionId = socket.handshake.auth?.sessionId;
  if (authSessionId && typeof authSessionId === "string") {
    return authSessionId;
  }
  return null;
};

const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return "0s";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
};

const getMergedOnlineSeconds = (sessions, now = new Date()) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;

  const nowMs = now.getTime();
  const intervals = sessions
    .map((session) => {
      const start = new Date(session.loginTime).getTime();
      const end = session.logoutTime
        ? new Date(session.logoutTime).getTime()
        : nowMs;
      if (end <= start) return null;
      return [start, end];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  if (!intervals.length) return 0;
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

const buildMarketingUserStatus = async (user) => {
  const currentSession = await UserSession.findOne(
    { user: user._id, tenantId: user.tenantId, isActive: true },
    {},
    { sort: { loginTime: -1 } },
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todaySessions = await UserSession.find({
    user: user._id,
    tenantId: user.tenantId,
    loginTime: { $gte: today },
  });

  const todayTotalSeconds = getMergedOnlineSeconds(todaySessions, new Date());

  return {
    userId: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isOnline: Boolean(currentSession),
    lastLogin: currentSession?.loginTime || user.lastLogin,
    currentSessionDuration: currentSession
      ? Math.floor((new Date() - currentSession.loginTime) / 1000)
      : 0,
    todayTotalOnlineSeconds: todayTotalSeconds,
    todayTotalOnlineTime: formatDuration(todayTotalSeconds),
    sessionsToday: todaySessions.length,
  };
};

const getAllMarketingStatuses = async (tenantId) => {
  const marketingUsers = await User.find({
    role: "marketing",
    isActive: true,
    tenantId,
  }).select("-password -refreshToken");

  return Promise.all(
    marketingUsers.map((user) => buildMarketingUserStatus(user)),
  );
};

export const initializeSocketServer = (httpServer) => {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:5173",
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = getTokenFromSocket(socket);
      if (!token) {
        return next(new Error("Authentication token missing"));
      }

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id).select(
        "-password -refreshToken",
      );

      if (!user || !user.isActive) {
        return next(new Error("Authentication failed"));
      }

      // SECURITY: Verify tenant match (parity with HTTP protect middleware)
      if (
        !decoded.tenantId ||
        String(user.tenantId) !== String(decoded.tenantId)
      ) {
        logger.warn(
          `WebSocket tenant mismatch: user ${user._id} token=${decoded.tenantId} db=${user.tenantId}`,
        );
        return next(new Error("Authentication failed — tenant mismatch"));
      }

      // SECURITY: Verify tenant is active (parity with HTTP protect middleware)
      const Tenant = (await import("../models/Tenant.js")).default;
      const tenant = await Tenant.findById(user.tenantId)
        .select("isActive")
        .lean();
      if (!tenant || !tenant.isActive) {
        return next(new Error("Tenant is inactive"));
      }

      socket.data.user = user;
      next();
    } catch (error) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user;
    const userId = String(user._id);
    const tenantId = String(user.tenantId);
    const userRoom = `user:${userId}`;
    const adminRoom = `admins:${tenantId}`;
    const clientSessionId =
      getClientSessionIdFromSocket(socket) || `socket:${socket.id}`;
    const sessionRoom = `session:${userId}:${clientSessionId}`;
    const disconnectKey = `${userId}:${clientSessionId}`;

    socket.join(userRoom);
    socket.join(sessionRoom);
    if (user.role === "admin") {
      socket.join(adminRoom);
      const statuses = await getAllMarketingStatuses(user.tenantId);
      socket.emit("marketing:status_snapshot", statuses);
    }

    const pendingTimer = pendingDisconnectTimers.get(disconnectKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingDisconnectTimers.delete(disconnectKey);
    }

    // Reuse active session for the same browser tab (refresh/hard refresh).
    let session = await UserSession.findOne(
      { user: user._id, clientSessionId, isActive: true },
      {},
      { sort: { loginTime: -1 } },
    );
    if (!session) {
      session = await UserSession.create({
        user: user._id,
        tenantId: user.tenantId,
        loginTime: new Date(),
        isActive: true,
        ipAddress: socket.handshake.address,
        userAgent: socket.handshake.headers["user-agent"],
        clientSessionId,
      });
    }
    socket.data.sessionId = String(session._id);
    socket.data.disconnectKey = disconnectKey;
    socket.data.sessionRoom = sessionRoom;

    if (user.role === "marketing") {
      const status = await buildMarketingUserStatus(user);
      io.to(adminRoom).emit("marketing:status_changed", status);
    }

    socket.on("disconnect", async () => {
      const timeoutId = setTimeout(async () => {
        try {
          const stillConnected =
            (io.sockets.adapter.rooms.get(socket.data.sessionRoom)?.size || 0) >
            0;
          if (stillConnected) return;

          if (socket.data.sessionId) {
            await UserSession.findByIdAndUpdate(socket.data.sessionId, {
              isActive: false,
              logoutTime: new Date(),
            });
          }

          if (user.role === "marketing") {
            const refreshedUser = await User.findById(user._id).select(
              "-password -refreshToken",
            );
            if (refreshedUser) {
              const status = await buildMarketingUserStatus(refreshedUser);
              io.to(adminRoom).emit("marketing:status_changed", status);
            }
          }
        } catch (error) {
          logger.error(`Socket disconnect cleanup failed: ${error.message}`);
        } finally {
          pendingDisconnectTimers.delete(socket.data.disconnectKey);
        }
      }, DISCONNECT_GRACE_MS);

      pendingDisconnectTimers.set(socket.data.disconnectKey, timeoutId);
    });
  });

  logger.info("Socket.IO server initialized");
  return io;
};

export const getIO = () => io;
