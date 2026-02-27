import Deal from "../../models/crm/Deal.js";
import Pipeline from "../../models/crm/Pipeline.js";
import Blueprint from "../../models/crm/Blueprint.js";
import AuditLog from "../../models/AuditLog.js";
import { ApiError } from "../../utils/apiResponse.js";
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
import {
  buildSafeSearch,
  buildSafeSort,
} from "../../utils/safeQueryBuilder.js";

const DEAL_SORT_FIELDS = [
  "name",
  "amount",
  "closeDate",
  "stage",
  "createdAt",
  "updatedAt",
];

/**
 * DealService — CRUD + pipeline stage management for CRM Deals.
 */
const DealService = {
  /**
   * List deals with filters and pagination.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      pipelineId,
      stage,
      ownerId,
      contactId,
      accountId,
      search,
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
    const safeSort = buildSafeSort(sortString, DEAL_SORT_FIELDS, "-createdAt");

    const filter = { tenantId, deletedAt: null };
    if (pipelineId) filter.pipelineId = pipelineId;
    if (stage) filter.stage = stage;
    if (ownerId) filter.ownerId = ownerId;
    if (contactId) filter.contactId = contactId;
    if (accountId) filter.accountId = accountId;
    if (search) {
      const safeSearch = buildSafeSearch(search);
      if (safeSearch) filter.name = safeSearch;
    }

    const [deals, totalDocs] = await Promise.all([
      Deal.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("ownerId", "name email")
        .populate("contactId", "fullName email")
        .populate("accountId", "name")
        .populate("pipelineId", "name")
        .lean(),
      Deal.countDocuments(filter),
    ]);

    return {
      deals,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  async getById(tenantId, dealId) {
    const deal = await Deal.findOne({ _id: dealId, tenantId, deletedAt: null })
      .populate("ownerId", "name email")
      .populate("contactId", "fullName email phone")
      .populate("accountId", "name industry")
      .populate("pipelineId", "name stages");
    return resolveRecordReferences(tenantId, "deals", deal);
  },

  /**
   * Create a new deal. Auto-assigns to default pipeline if none specified.
   */
  async create(tenantId, data, user) {
    data = sanitizeCreatePayload("deals", data, user.role);
    if (!data.ownerId) {
      data.ownerId = user._id;
    }
    await assertTenantScopedRefs(tenantId, "deals", data);

    // Resolve pipeline
    let pipeline;
    if (data.pipelineId) {
      pipeline = await Pipeline.findOne({
        _id: data.pipelineId,
        tenantId,
        isActive: true,
      });
      if (!pipeline) throw ApiError.badRequest("Pipeline not found");
    } else {
      pipeline = await Pipeline.getDefaultForTenant(tenantId);
    }

    // If no stage specified, use first stage
    const sortedStages = pipeline.getSortedStages();
    if (!data.stage) {
      data.stage = sortedStages[0].name;
    }

    // Validate stage exists in pipeline
    const stageObj = pipeline.stages.find((s) => s.name === data.stage);
    if (!stageObj)
      throw ApiError.badRequest(`Stage "${data.stage}" not found in pipeline`);

    // Validate & index custom data
    if (data.customData) {
      data = await processCustomData(tenantId, "deals", data, user.role);
    }

    const deal = await Deal.create({
      ...data,
      tenantId,
      pipelineId: pipeline._id,
      probability: stageObj.probability,
      stageHistory: [
        { stage: data.stage, enteredAt: new Date(), movedBy: user._id },
      ],
    });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.create",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal created: ${deal.name}`,
      metadata: {
        pipelineId: pipeline._id,
        stage: deal.stage,
        amount: deal.amount,
      },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },

  /**
   * Update deal fields (non-stage).
   */
  async update(tenantId, dealId, data, user) {
    // Don't allow stage change through generic update
    delete data.stage;
    delete data.stageHistory;

    data = sanitizeUpdatePayload("deals", data, user.role);

    const deal = await Deal.findOne({ _id: dealId, tenantId, deletedAt: null });
    if (!deal) return null;

    await assertTenantScopedRefs(tenantId, "deals", data);

    if (data.customData) {
      data = await processCustomData(tenantId, "deals", data, user.role);
    }

    Object.assign(deal, data);
    await deal.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.update",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal updated: ${deal.name}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },

  /**
   * Move deal to a new stage (controlled transition).
   * Validates pipeline stages, blueprint rules, and records stage history.
   */
  async changeStage(tenantId, dealId, newStage, user) {
    const deal = await Deal.findOne({ _id: dealId, tenantId, deletedAt: null });
    if (!deal) throw ApiError.notFound("Deal not found");

    if (deal.stage === newStage)
      throw ApiError.badRequest("Deal is already in this stage");

    const pipeline = await Pipeline.findOne({ _id: deal.pipelineId, tenantId });
    if (!pipeline) throw ApiError.internal("Pipeline not found for deal");

    // Validate transition in pipeline
    const stageValidation = pipeline.validateStageTransition(
      deal.stage,
      newStage,
    );
    if (!stageValidation.valid)
      throw ApiError.badRequest(stageValidation.reason);

    // Check blueprint (if active)
    const blueprint = await Blueprint.getActiveForModule(tenantId, "deal");
    if (blueprint) {
      const bpResult = blueprint.validateTransition(
        deal.stage,
        newStage,
        user.role,
        deal.toObject(),
      );
      if (!bpResult.valid) throw ApiError.badRequest(bpResult.reason);
    }

    const oldStage = deal.stage;
    const now = new Date();

    // Close out old stage history entry
    const lastHistoryEntry = deal.stageHistory[deal.stageHistory.length - 1];
    if (lastHistoryEntry && !lastHistoryEntry.exitedAt) {
      lastHistoryEntry.exitedAt = now;
      lastHistoryEntry.durationMs = now - lastHistoryEntry.enteredAt;
    }

    // Set new stage
    deal.stage = newStage;
    deal.probability = stageValidation.toStage.probability;
    deal.stageHistory.push({
      stage: newStage,
      enteredAt: now,
      movedBy: user._id,
    });

    // Handle terminal stages
    if (stageValidation.toStage.isClosed) {
      if (stageValidation.toStage.isWon) {
        deal.wonAt = now;
      } else {
        deal.lostAt = now;
      }
    }

    await deal.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.stage_change",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal stage: ${oldStage} → ${newStage}`,
      metadata: { oldStage, newStage, probability: deal.probability },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },

  async softDelete(tenantId, dealId, user) {
    const deal = await Deal.findOne({ _id: dealId, tenantId, deletedAt: null });
    if (!deal) return null;

    deal.deletedAt = new Date();
    deal.deletedBy = user._id;
    await deal.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.delete",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal deleted: ${deal.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },

  async restore(tenantId, dealId, user) {
    const deal = await Deal.findOne({
      _id: dealId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!deal) return null;

    deal.deletedAt = null;
    deal.deletedBy = null;
    await deal.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.restore",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal restored: ${deal.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },

  async assignOwner(tenantId, dealId, newOwnerId, user) {
    // Prevent cross-tenant owner injection
    await assertTenantScopedRefs(tenantId, "deals", { ownerId: newOwnerId });

    const deal = await Deal.findOne({ _id: dealId, tenantId, deletedAt: null });
    if (!deal) return null;

    const oldOwnerId = deal.ownerId;
    deal.ownerId = newOwnerId;
    await deal.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "deal.assign",
      entityType: "deal",
      entityId: deal._id,
      description: `Deal owner changed`,
      metadata: { oldOwnerId, newOwnerId },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return deal;
  },
};

export default DealService;
