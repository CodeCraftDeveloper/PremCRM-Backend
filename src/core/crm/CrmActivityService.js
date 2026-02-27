import CrmActivity from "../../models/crm/CrmActivity.js";
import AuditLog from "../../models/AuditLog.js";
import {
  processCustomData,
  resolveRecordReferences,
} from "./customDataHelper.js";
import {
  sanitizeCreatePayload,
  sanitizeUpdatePayload,
} from "../../utils/sanitizePayload.js";
import { assertTenantScopedRefs } from "../../utils/tenantRefGuard.js";
import { enforcePagination } from "../../utils/pagination.js";
import { buildSafeSort } from "../../utils/safeQueryBuilder.js";

const ACTIVITY_SORT_FIELDS = [
  "type",
  "subject",
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "updatedAt",
];

/**
 * CrmActivityService — CRUD for Tasks, Calls, Meetings, Emails.
 * Polymorphic: activities relate to Lead, Contact, Deal, or Account.
 */
const CrmActivityService = {
  /**
   * List activities with filters.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      type,
      status,
      ownerId,
      entityType,
      entityId,
      dueBefore,
      sort,
    } = {},
  ) {
    const { page, limit, skip } = enforcePagination({
      page: rawPage,
      limit: rawLimit,
    });
    const sortString =
      sort && sort.field
        ? `${sort.direction === "desc" ? "-" : ""}${sort.field}`
        : undefined;
    const safeSort = buildSafeSort(sortString, ACTIVITY_SORT_FIELDS, "-createdAt");

    const filter = { tenantId, deletedAt: null };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (ownerId) filter.ownerId = ownerId;
    if (entityType && entityId) {
      filter["relatedTo.entityType"] = entityType;
      filter["relatedTo.entityId"] = entityId;
    }
    if (dueBefore) filter.dueDate = { $lte: new Date(dueBefore) };

    const [activities, totalDocs] = await Promise.all([
      CrmActivity.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("ownerId", "name email")
        .lean(),
      CrmActivity.countDocuments(filter),
    ]);

    return {
      activities,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  async getById(tenantId, activityId) {
    const activity = await CrmActivity.findOne({
      _id: activityId,
      tenantId,
      deletedAt: null,
    })
      .populate("ownerId", "name email")
      .populate("participants", "name email");
    return resolveRecordReferences(tenantId, "activities", activity);
  },

  /**
   * Get all activities for a specific entity (polymorphic lookup).
   */
  async getForEntity(
    tenantId,
    entityType,
    entityId,
    { page = 1, limit = 20 } = {},
  ) {
    const filter = {
      tenantId,
      deletedAt: null,
      "relatedTo.entityType": entityType,
      "relatedTo.entityId": entityId,
    };

    const skip = (page - 1) * limit;
    const [activities, totalDocs] = await Promise.all([
      CrmActivity.find(filter)
        .sort("-createdAt")
        .skip(skip)
        .limit(limit)
        .populate("ownerId", "name email")
        .lean(),
      CrmActivity.countDocuments(filter),
    ]);

    return {
      activities,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  async create(tenantId, data, user) {
    data = sanitizeCreatePayload("activities", data, user.role);

    if (!data.ownerId) {
      data.ownerId = user._id;
    }
    if (
      data.relatedTo &&
      (!data.relatedTo.entityType || !data.relatedTo.entityId)
    ) {
      delete data.relatedTo;
    }

    await assertTenantScopedRefs(tenantId, "activities", data);

    if (data.customData) {
      data = await processCustomData(tenantId, "activities", data, user.role);
    }
    const activity = await CrmActivity.create({ ...data, tenantId });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "activity.create",
      entityType: "activity",
      entityId: activity._id,
      description: `Activity created: ${activity.type} — ${activity.subject}`,
      metadata: { relatedTo: activity.relatedTo },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return activity;
  },

  async update(tenantId, activityId, data, user) {
    const activity = await CrmActivity.findOne({
      _id: activityId,
      tenantId,
      deletedAt: null,
    });
    if (!activity) return null;

    const oldStatus = activity.status;

    data = sanitizeUpdatePayload("activities", data, user.role);
    await assertTenantScopedRefs(tenantId, "activities", data);

    if (data.customData) {
      data = await processCustomData(tenantId, "activities", data, user.role);
    }

    Object.assign(activity, data);

    // Auto-set completedAt
    if (data.status === "completed" && !activity.completedAt) {
      activity.completedAt = new Date();
    }

    await activity.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "activity.update",
      entityType: "activity",
      entityId: activity._id,
      description: `Activity updated: ${activity.subject}`,
      metadata: {
        updatedFields: Object.keys(data),
        oldStatus,
        newStatus: activity.status,
      },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return activity;
  },

  async softDelete(tenantId, activityId, user) {
    const activity = await CrmActivity.findOne({
      _id: activityId,
      tenantId,
      deletedAt: null,
    });
    if (!activity) return null;

    activity.deletedAt = new Date();
    activity.deletedBy = user._id;
    await activity.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "activity.delete",
      entityType: "activity",
      entityId: activity._id,
      description: `Activity deleted: ${activity.subject}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return activity;
  },

  async restore(tenantId, activityId, user) {
    const activity = await CrmActivity.findOne({
      _id: activityId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!activity) return null;

    activity.deletedAt = null;
    activity.deletedBy = null;
    await activity.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "activity.restore",
      entityType: "activity",
      entityId: activity._id,
      description: `Activity restored: ${activity.subject}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return activity;
  },
};

export default CrmActivityService;
