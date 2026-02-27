import CustomModule from "../../models/crm/CustomModule.js";
import AuditLog from "../../models/AuditLog.js";
import { enforcePagination } from "../../utils/pagination.js";
import {
  buildSafeSearch,
  buildSafeSort,
} from "../../utils/safeQueryBuilder.js";

const MODULE_SORT_FIELDS = ["displayName", "apiName", "createdAt", "updatedAt"];

/**
 * CustomModuleService — CRUD for tenant-defined CRM modules.
 * All operations are tenant-scoped.
 */
const CustomModuleService = {
  /**
   * List custom modules with optional filters.
   */
  async list(
    tenantId,
    { page: rawPage, limit: rawLimit, search, isActive, sort } = {},
  ) {
    const { page, limit, skip } = enforcePagination(
      { page: rawPage, limit: rawLimit },
      50,
    );
    const safeSort = buildSafeSort(sort, MODULE_SORT_FIELDS, "displayName");

    const filter = { tenantId, deletedAt: null };
    if (typeof isActive === "boolean") filter.isActive = isActive;
    if (search) {
      const safeSearch = buildSafeSearch(search);
      if (safeSearch) {
        filter.$or = [{ displayName: safeSearch }, { apiName: safeSearch }];
      }
    }

    const [modules, totalDocs] = await Promise.all([
      CustomModule.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("createdBy", "name email")
        .lean(),
      CustomModule.countDocuments(filter),
    ]);

    return {
      modules,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  /**
   * Get a single custom module by ID.
   */
  async getById(tenantId, moduleId) {
    return CustomModule.findOne({
      _id: moduleId,
      tenantId,
      deletedAt: null,
    }).populate("createdBy", "name email");
  },

  /**
   * Get a custom module by its apiName.
   */
  async getByApiName(tenantId, apiName) {
    return CustomModule.findOne({
      tenantId,
      apiName,
      deletedAt: null,
    }).populate("createdBy", "name email");
  },

  /**
   * Create a new custom module.
   */
  async create(tenantId, data, user) {
    // Check duplicate apiName within tenant
    const existing = await CustomModule.findOne({
      tenantId,
      apiName: data.apiName,
      deletedAt: null,
    });
    if (existing) {
      const err = new Error(
        `Module with apiName "${data.apiName}" already exists`,
      );
      err.statusCode = 409;
      throw err;
    }

    // Auto-generate collectionName if not provided
    if (!data.collectionName) {
      data.collectionName = `cm_${data.apiName}`;
    }

    const mod = await CustomModule.create({
      ...data,
      tenantId,
      createdBy: user._id,
    });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "custom_module.create",
      entityType: "custom_module",
      entityId: mod._id,
      description: `Custom module created: ${mod.displayName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return mod;
  },

  /**
   * Update a custom module.
   */
  async update(tenantId, moduleId, data, user) {
    const mod = await CustomModule.findOne({
      _id: moduleId,
      tenantId,
      deletedAt: null,
    });
    if (!mod) return null;

    // apiName is immutable after creation
    delete data.apiName;
    delete data.collectionName;

    Object.assign(mod, data);
    await mod.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "custom_module.update",
      entityType: "custom_module",
      entityId: mod._id,
      description: `Custom module updated: ${mod.displayName}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return mod;
  },

  /**
   * Soft delete a custom module.
   */
  async softDelete(tenantId, moduleId, user) {
    const mod = await CustomModule.findOne({
      _id: moduleId,
      tenantId,
      deletedAt: null,
      isSystem: false, // cannot delete system modules
    });
    if (!mod) return null;

    mod.deletedAt = new Date();
    mod.deletedBy = user._id;
    await mod.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "custom_module.delete",
      entityType: "custom_module",
      entityId: mod._id,
      description: `Custom module deleted: ${mod.displayName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return mod;
  },

  /**
   * Restore a soft-deleted custom module.
   */
  async restore(tenantId, moduleId, user) {
    const mod = await CustomModule.findOne({
      _id: moduleId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!mod) return null;

    mod.deletedAt = null;
    mod.deletedBy = null;
    await mod.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "custom_module.restore",
      entityType: "custom_module",
      entityId: mod._id,
      description: `Custom module restored: ${mod.displayName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return mod;
  },

  /**
   * Toggle active state.
   */
  async toggleActive(tenantId, moduleId, user) {
    const mod = await CustomModule.findOne({
      _id: moduleId,
      tenantId,
      deletedAt: null,
    });
    if (!mod) return null;

    mod.isActive = !mod.isActive;
    await mod.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "custom_module.toggle",
      entityType: "custom_module",
      entityId: mod._id,
      description: `Custom module ${mod.isActive ? "activated" : "deactivated"}: ${mod.displayName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return mod;
  },
};

export default CustomModuleService;
