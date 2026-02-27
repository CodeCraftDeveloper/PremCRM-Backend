import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../../utils/apiResponse.js";
import AutomationRule from "../../models/crm/AutomationRule.js";
import WorkflowExecution from "../../models/crm/WorkflowExecution.js";
import AuditLog from "../../models/AuditLog.js";
import { enforcePagination, MAX_LIMIT } from "../../utils/pagination.js";

// ── Allowlists for mass-assignment protection ─────────────────────────────
// Only these fields may be set by the caller on create.
const CREATE_ALLOWED_FIELDS = [
  "name",
  "description",
  "isActive",
  "module",
  "trigger",
  "conditions",
  "actions",
];

// On update, module is immutable — excluded from the allowlist.
const UPDATE_ALLOWED_FIELDS = [
  "name",
  "description",
  "isActive",
  "trigger",
  "conditions",
  "actions",
];

function pickAllowed(body, allowedFields) {
  const result = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      result[field] = body[field];
    }
  }
  return result;
}

const enrichUser = (req) => ({
  ...(req.user._doc || req.user),
  _id: req.user._id,
  role: req.user.role,
  _ipAddress: req.ip,
  _userAgent: req.get("user-agent"),
  _requestId: req.requestId,
});

// ──────────── Automation Rules ────────────

/**
 * @route   GET /api/v1/crm/workflows/rules
 */
export const getRules = asyncHandler(async (req, res, next) => {
  try {
    const { module, isActive } = req.query;
    const filter = { tenantId: req.user.tenantId, deletedAt: null };
    if (module) filter.module = module;
    if (isActive !== undefined) filter.isActive = isActive === "true";

    const rules = await AutomationRule.find(filter)
      .sort("-createdAt")
      .limit(MAX_LIMIT)
      .populate("createdBy", "name email")
      .lean();

    successResponse(res, rules, "Rules retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/crm/workflows/rules/:id
 */
export const getRule = asyncHandler(async (req, res, next) => {
  try {
    const rule = await AutomationRule.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    }).populate("createdBy", "name email");
    if (!rule) return next(ApiError.notFound("Rule not found"));
    successResponse(res, rule, "Rule retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/crm/workflows/rules
 */
export const createRule = asyncHandler(async (req, res, next) => {
  try {
    const user = enrichUser(req);
    const data = pickAllowed(req.body, CREATE_ALLOWED_FIELDS);
    const rule = await AutomationRule.create({
      ...data,
      tenantId: req.user.tenantId,
      createdBy: user._id,
    });

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: user._id,
      action: "automation.create",
      entityType: "automation",
      entityId: rule._id,
      description: `Automation rule created: ${rule.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    successResponse(res, rule, "Rule created", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/v1/crm/workflows/rules/:id
 */
export const updateRule = asyncHandler(async (req, res, next) => {
  try {
    const user = enrichUser(req);
    const rule = await AutomationRule.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });
    if (!rule) return next(ApiError.notFound("Rule not found"));

    const updates = pickAllowed(req.body, UPDATE_ALLOWED_FIELDS);
    Object.assign(rule, updates);
    await rule.save();

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: user._id,
      action: "automation.update",
      entityType: "automation",
      entityId: rule._id,
      description: `Automation rule updated: ${rule.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    successResponse(res, rule, "Rule updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/crm/workflows/rules/:id
 */
export const deleteRule = asyncHandler(async (req, res, next) => {
  try {
    const user = enrichUser(req);
    const rule = await AutomationRule.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });
    if (!rule) return next(ApiError.notFound("Rule not found"));

    rule.deletedAt = new Date();
    rule.deletedBy = user._id;
    await rule.save();

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: user._id,
      action: "automation.delete",
      entityType: "automation",
      entityId: rule._id,
      description: `Automation rule deleted: ${rule.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    successResponse(res, null, "Rule deleted");
  } catch (error) {
    next(error);
  }
});

// ──────────── Workflow Executions ────────────

/**
 * @route   GET /api/v1/crm/workflows/executions
 */
export const getExecutions = asyncHandler(async (req, res, next) => {
  try {
    const { ruleId, status } = req.query;
    const { page, limit, skip } = enforcePagination({
      page: req.query.page,
      limit: req.query.limit,
    });
    const filter = { tenantId: req.user.tenantId };
    if (ruleId) filter.ruleId = ruleId;
    if (status) filter.status = status;

    const [executions, totalDocs] = await Promise.all([
      WorkflowExecution.find(filter)
        .sort("-createdAt")
        .skip(skip)
        .limit(limit)
        .populate("ruleId", "name module")
        .lean(),
      WorkflowExecution.countDocuments(filter),
    ]);

    paginatedResponse(
      res,
      executions,
      {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
      "Executions retrieved",
    );
  } catch (error) {
    next(error);
  }
});
