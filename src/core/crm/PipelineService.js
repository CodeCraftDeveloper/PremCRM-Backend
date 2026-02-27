import Pipeline from "../../models/crm/Pipeline.js";
import AuditLog from "../../models/AuditLog.js";
import { ApiError } from "../../utils/apiResponse.js";
import { MAX_LIMIT } from "../../utils/pagination.js";

/**
 * PipelineService — CRUD for sales pipelines with embedded stages.
 */
const PipelineService = {
  async list(tenantId) {
    return Pipeline.find({ tenantId }).sort("name").limit(MAX_LIMIT).lean();
  },

  async getById(tenantId, pipelineId) {
    return Pipeline.findOne({ _id: pipelineId, tenantId });
  },

  async getDefault(tenantId) {
    return Pipeline.getDefaultForTenant(tenantId);
  },

  /**
   * Create a new pipeline with stages.
   */
  async create(tenantId, data, user) {
    // Validate stage order uniqueness
    const orders = data.stages.map((s) => s.order);
    if (new Set(orders).size !== orders.length) {
      throw ApiError.badRequest("Stage orders must be unique");
    }

    const pipeline = await Pipeline.create({ ...data, tenantId });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "pipeline.create",
      entityType: "pipeline",
      entityId: pipeline._id,
      description: `Pipeline created: ${pipeline.name}`,
      metadata: { stageCount: pipeline.stages.length },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return pipeline;
  },

  /**
   * Update pipeline (name, isActive, isDefault).
   */
  async update(tenantId, pipelineId, data, user) {
    const pipeline = await Pipeline.findOne({ _id: pipelineId, tenantId });
    if (!pipeline) return null;

    if (data.name !== undefined) pipeline.name = data.name;
    if (data.isActive !== undefined) pipeline.isActive = data.isActive;
    if (data.isDefault !== undefined) pipeline.isDefault = data.isDefault;

    await pipeline.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "pipeline.update",
      entityType: "pipeline",
      entityId: pipeline._id,
      description: `Pipeline updated: ${pipeline.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return pipeline;
  },

  /**
   * Replace pipeline stages (full overwrite).
   */
  async updateStages(tenantId, pipelineId, stages, user) {
    const pipeline = await Pipeline.findOne({ _id: pipelineId, tenantId });
    if (!pipeline) return null;

    const orders = stages.map((s) => s.order);
    if (new Set(orders).size !== orders.length) {
      throw ApiError.badRequest("Stage orders must be unique");
    }

    pipeline.stages = stages;
    await pipeline.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "pipeline.stage_update",
      entityType: "pipeline",
      entityId: pipeline._id,
      description: `Pipeline stages updated: ${pipeline.name}`,
      metadata: { stageCount: stages.length },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return pipeline;
  },
};

export default PipelineService;
