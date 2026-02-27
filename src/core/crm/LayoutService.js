import ModuleLayout from "../../models/crm/ModuleLayout.js";
import AuditLog from "../../models/AuditLog.js";
import { MAX_LIMIT } from "../../utils/pagination.js";
import { buildSafeSort } from "../../utils/safeQueryBuilder.js";

const LAYOUT_SORT_FIELDS = [
  "moduleApiName",
  "layoutType",
  "createdAt",
  "updatedAt",
];

/**
 * LayoutService — CRUD for module layout definitions.
 * Controls how fields are arranged in detail/edit/create/list/kanban views.
 * All operations are tenant-scoped.
 */
const LayoutService = {
  /**
   * List layouts with optional filters.
   */
  async list(tenantId, { moduleApiName, layoutType, isActive, sort } = {}) {
    const safeSort = buildSafeSort(sort, LAYOUT_SORT_FIELDS, "moduleApiName");
    const filter = { tenantId };
    if (moduleApiName) filter.moduleApiName = moduleApiName;
    if (layoutType) filter.layoutType = layoutType;
    if (typeof isActive === "boolean") filter.isActive = isActive;

    return ModuleLayout.find(filter)
      .sort(safeSort)
      .limit(MAX_LIMIT)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();
  },

  /**
   * Get a single layout by ID.
   */
  async getById(tenantId, layoutId) {
    return ModuleLayout.findOne({ _id: layoutId, tenantId })
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
  },

  /**
   * Get the active layout for a module + type combination.
   */
  async getActiveLayout(tenantId, moduleApiName, layoutType) {
    return ModuleLayout.findOne({
      tenantId,
      moduleApiName,
      layoutType,
      isActive: true,
    }).lean();
  },

  /**
   * Create or upsert a layout.
   * Only one layout per (tenant, module, type) — upserts by default.
   */
  async upsert(tenantId, data, user) {
    const { moduleApiName, layoutType } = data;

    let layout = await ModuleLayout.findOne({
      tenantId,
      moduleApiName,
      layoutType,
    });

    const isNew = !layout;

    if (isNew) {
      layout = await ModuleLayout.create({
        ...data,
        tenantId,
        createdBy: user._id,
        updatedBy: user._id,
      });
    } else {
      // Keep immutable fields
      delete data.moduleApiName;
      delete data.layoutType;

      Object.assign(layout, data, { updatedBy: user._id });
      await layout.save();
    }

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: isNew ? "module_layout.create" : "module_layout.update",
      entityType: "module_layout",
      entityId: layout._id,
      description: `Layout ${isNew ? "created" : "updated"}: ${moduleApiName} / ${layoutType}`,
      metadata: { moduleApiName, layoutType },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return layout;
  },

  /**
   * Update a layout by ID.
   */
  async update(tenantId, layoutId, data, user) {
    const layout = await ModuleLayout.findOne({ _id: layoutId, tenantId });
    if (!layout) return null;

    // Immutable after creation
    delete data.moduleApiName;
    delete data.layoutType;

    Object.assign(layout, data, { updatedBy: user._id });
    await layout.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "module_layout.update",
      entityType: "module_layout",
      entityId: layout._id,
      description: `Layout updated: ${layout.moduleApiName} / ${layout.layoutType}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return layout;
  },

  /**
   * Delete a layout.
   */
  async remove(tenantId, layoutId, user) {
    const layout = await ModuleLayout.findOne({ _id: layoutId, tenantId });
    if (!layout) return null;

    await layout.deleteOne();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "module_layout.delete",
      entityType: "module_layout",
      entityId: layout._id,
      description: `Layout deleted: ${layout.moduleApiName} / ${layout.layoutType}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return layout;
  },

  /**
   * Add a section to a layout.
   */
  async addSection(tenantId, layoutId, sectionData, user) {
    const layout = await ModuleLayout.findOne({ _id: layoutId, tenantId });
    if (!layout) return null;

    // Auto-assign sortOrder
    const maxSort = layout.sections.reduce(
      (max, s) => Math.max(max, s.sortOrder ?? 0),
      -1,
    );
    sectionData.sortOrder = sectionData.sortOrder ?? maxSort + 1;

    layout.sections.push(sectionData);
    layout.updatedBy = user._id;
    await layout.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "module_layout.section_add",
      entityType: "module_layout",
      entityId: layout._id,
      description: `Section added to ${layout.moduleApiName} layout`,
      metadata: { sectionTitle: sectionData.title },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return layout;
  },

  /**
   * Reorder sections in a layout.
   * @param {Array} sectionOrders - Array of { sectionId, sortOrder }
   */
  async reorderSections(tenantId, layoutId, sectionOrders, user) {
    const layout = await ModuleLayout.findOne({ _id: layoutId, tenantId });
    if (!layout) return null;

    for (const { sectionId, sortOrder } of sectionOrders) {
      const section = layout.sections.id(sectionId);
      if (section) {
        section.sortOrder = sortOrder;
      }
    }

    layout.updatedBy = user._id;
    await layout.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "module_layout.section_reorder",
      entityType: "module_layout",
      entityId: layout._id,
      description: `Sections reordered in ${layout.moduleApiName} layout`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return layout;
  },
};

export default LayoutService;
