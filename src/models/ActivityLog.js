import mongoose from "mongoose";
import { deleteCache } from "../config/redis.js";

const activityLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        // Auth actions
        "login",
        "logout",
        "password_change",
        "password_reset",
        // User actions
        "user_create",
        "user_update",
        "user_delete",
        "user_activate",
        "user_deactivate",
        // Event actions
        "event_create",
        "event_update",
        "event_delete",
        // Client actions
        "client_create",
        "client_update",
        "client_delete",
        "client_status_change",
        "client_assign",
        // Remark actions
        "remark_create",
        "remark_update",
        "remark_delete",
        // File actions
        "file_upload",
        "file_delete",
        // Export actions
        "data_export",
      ],
    },
    resourceType: {
      type: String,
      enum: ["user", "event", "client", "remark", "file", "system"],
      required: true,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    description: {
      type: String,
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
activityLogSchema.index({ user: 1, createdAt: -1 });
activityLogSchema.index({ action: 1 });
activityLogSchema.index({ resourceType: 1, resourceId: 1 });
activityLogSchema.index({ createdAt: -1 });

// TTL index to auto-delete logs older than 90 days (optional)
// activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

// Static method to log activity
activityLogSchema.statics.log = async function (data) {
  try {
    const logDoc = await this.create(data);
    const userId = data.user ? String(data.user) : null;

    await Promise.all([
      deleteCache("dashboard:admin"),
      userId ? deleteCache(`dashboard:marketing:${userId}`) : Promise.resolve(),
    ]);

    // Emit real-time events for dashboards when socket server is available.
    try {
      const { getIO } = await import("../socket/index.js");
      const io = getIO();
      if (io) {
        const action = String(data.action || "");

        if (userId) {
          io.to(`user:${userId}`).emit("activity:new", logDoc);
          io.to(`user:${userId}`).emit("dashboard:refresh", {
            reason: action,
          });
        }

        // Admin dashboards should refresh for system/client/user/event changes.
        io.to("admins").emit("dashboard:refresh", { reason: action });
      }
    } catch {
      // Socket emission failures should never break API flow.
    }

    return logDoc;
  } catch (error) {
    console.error("Failed to create activity log:", error);
    // Don't throw - activity logging shouldn't break the main flow
    return null;
  }
};

// Static method to get user activity
activityLogSchema.statics.getUserActivity = function (userId, options = {}) {
  const { limit = 50, page = 1, actions = null } = options;

  const query = { user: userId };
  if (actions && actions.length > 0) {
    query.action = { $in: actions };
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

// Static method to get activity for a resource
activityLogSchema.statics.getResourceActivity = function (
  resourceType,
  resourceId,
  options = {},
) {
  const { limit = 50, page = 1 } = options;

  return this.find({ resourceType, resourceId })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("user", "name email");
};

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);

export default ActivityLog;
