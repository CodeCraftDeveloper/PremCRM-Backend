import Blueprint from "../../models/crm/Blueprint.js";
import AuditLog from "../../models/AuditLog.js";
import { MAX_LIMIT } from "../../utils/pagination.js";

/**
 * BlueprintService — CRUD for state machine blueprints + validation helper.
 */
const BlueprintService = {
  async list(tenantId, { module } = {}) {
    const filter = { tenantId };
    if (module) filter.module = module;
    return Blueprint.find(filter).sort("-createdAt").limit(MAX_LIMIT).lean();
  },

  async getById(tenantId, blueprintId) {
    return Blueprint.findOne({ _id: blueprintId, tenantId });
  },

  async create(tenantId, data, user) {
    // If creating an active blueprint, deactivate existing ones for the same module
    if (data.isActive) {
      await Blueprint.updateMany(
        { tenantId, module: data.module, isActive: true },
        { isActive: false },
      );
    }

    const blueprint = await Blueprint.create({
      ...data,
      tenantId,
      createdBy: user._id,
    });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "blueprint.create",
      entityType: "blueprint",
      entityId: blueprint._id,
      description: `Blueprint created: ${blueprint.name} for ${blueprint.module}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return blueprint;
  },

  async update(tenantId, blueprintId, data, user) {
    const blueprint = await Blueprint.findOne({ _id: blueprintId, tenantId });
    if (!blueprint) return null;

    // If activating, deactivate others for same module
    if (data.isActive && !blueprint.isActive) {
      await Blueprint.updateMany(
        {
          tenantId,
          module: blueprint.module,
          isActive: true,
          _id: { $ne: blueprintId },
        },
        { isActive: false },
      );
    }

    Object.assign(blueprint, data);
    await blueprint.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "blueprint.update",
      entityType: "blueprint",
      entityId: blueprint._id,
      description: `Blueprint updated: ${blueprint.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return blueprint;
  },

  async remove(tenantId, blueprintId, user) {
    const blueprint = await Blueprint.findOneAndDelete({
      _id: blueprintId,
      tenantId,
    });
    if (!blueprint) return null;

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "blueprint.delete",
      entityType: "blueprint",
      entityId: blueprint._id,
      description: `Blueprint deleted: ${blueprint.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return blueprint;
  },

  /**
   * Validate a transition for a given module.
   * Returns { valid, reason?, missingFields? } or null if no blueprint is active.
   */
  async validateTransition(
    tenantId,
    module,
    fromStage,
    toStage,
    userRole,
    entityData,
  ) {
    const blueprint = await Blueprint.getActiveForModule(tenantId, module);
    if (!blueprint) return { valid: true, noBlueprint: true };
    return blueprint.validateTransition(
      fromStage,
      toStage,
      userRole,
      entityData,
    );
  },
};

export default BlueprintService;
