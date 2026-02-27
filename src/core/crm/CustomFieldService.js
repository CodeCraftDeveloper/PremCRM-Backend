import CustomField, {
  FIELD_TYPES,
  PHASE1_FIELD_TYPES,
  MAX_FIELDS_PER_MODULE,
} from "../../models/crm/CustomField.js";
import AuditLog from "../../models/AuditLog.js";
import mongoose from "mongoose";
import customFieldCache from "./CustomFieldCache.js";
import {
  startTimer,
  buildSafeCustomFilter,
  checkReferenceDepth,
  MAX_FILTER_CONDITIONS,
} from "./customFieldPerf.js";
import { enforcePagination } from "../../utils/pagination.js";

// ── Built-in modules whose Mongoose model can be resolved ──
const MODULE_MODEL_MAP = {
  contacts: "Contact",
  accounts: "Account",
  deals: "Deal",
  activities: "CrmActivity",
  leads: "Lead",
};

/**
 * CustomFieldService — Phase 1 Dynamic Metadata Engine.
 *
 * Capabilities:
 *  - CRUD for tenant-defined custom fields
 *  - Max 100 fields per module per tenant
 *  - No nested object values (flat only)
 *  - Type-specific + generic validation (required, min/max, regex)
 *  - Conditional required (JSON rule engine)
 *  - Reference field resolver (safe 1-level join)
 *  - Role-based field visibility
 *  - Searchable index management
 *
 * All operations are tenant-scoped.
 */
const CustomFieldService = {
  // ═══════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════

  /**
   * List custom fields with optional filters.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      moduleApiName,
      fieldType,
      search,
      isActive,
      sort = "sortOrder",
    } = {},
  ) {
    const { page, limit, skip } = enforcePagination(
      { page: rawPage, limit: rawLimit },
      100,
    );

    const filter = { tenantId, deletedAt: null };
    if (moduleApiName) filter.moduleApiName = moduleApiName;
    if (fieldType) filter.fieldType = fieldType;
    if (typeof isActive === "boolean") filter.isActive = isActive;
    if (search) {
      filter.$or = [
        { label: { $regex: search, $options: "i" } },
        { apiName: { $regex: search, $options: "i" } },
      ];
    }

    const [fields, totalDocs] = await Promise.all([
      CustomField.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      CustomField.countDocuments(filter),
    ]);

    return {
      fields,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  /**
   * Get a single custom field by ID.
   */
  async getById(tenantId, fieldId) {
    return CustomField.findOne({ _id: fieldId, tenantId, deletedAt: null });
  },

  /**
   * Get fields for a module — optionally filtered by user role.
   * Uses in-memory cache (TTL 60s) to avoid redundant DB reads.
   * @param {string|null} userRole - If provided, filters by visibleToRoles.
   */
  async getByModule(tenantId, moduleApiName, userRole = null) {
    // Try cache first (stores ALL active fields, role filter applied after)
    let fields = customFieldCache.get(tenantId, moduleApiName);

    if (!fields) {
      const timer = startTimer("getByModule.db", {
        tenantId: String(tenantId),
        moduleApiName,
      });
      fields = await CustomField.find({
        tenantId,
        moduleApiName,
        deletedAt: null,
        isActive: true,
      })
        .sort("sortOrder")
        .lean();
      timer.end();

      // Store un-filtered set in cache
      customFieldCache.set(tenantId, moduleApiName, fields);
    }

    // Role-based visibility filter (applied post-cache)
    if (userRole) {
      return fields.filter(
        (f) =>
          !f.visibleToRoles ||
          f.visibleToRoles.length === 0 ||
          f.visibleToRoles.includes(userRole),
      );
    }
    return fields;
  },

  /**
   * Get module metadata — system fields + custom fields + layout hints.
   */
  async getModuleMetadata(tenantId, moduleApiName, userRole = null) {
    const fields = await this.getByModule(tenantId, moduleApiName, userRole);
    return {
      moduleApiName,
      customFields: fields,
      fieldCount: fields.length,
      maxFields: MAX_FIELDS_PER_MODULE,
      phase1Types: PHASE1_FIELD_TYPES,
    };
  },

  /**
   * Create a new custom field.
   * Enforces: type whitelist, max 100 fields, no nested objects, unique apiName.
   */
  async create(tenantId, data, user) {
    // ── Phase-1 type whitelist ──────────────────────────
    if (!FIELD_TYPES.includes(data.fieldType)) {
      const err = new Error(
        `Invalid field type: ${data.fieldType}. Valid types: ${PHASE1_FIELD_TYPES.join(", ")}`,
      );
      err.statusCode = 400;
      throw err;
    }

    // ── Max 100 fields per module ───────────────────────
    const currentCount = await CustomField.countDocuments({
      tenantId,
      moduleApiName: data.moduleApiName,
      deletedAt: null,
    });
    if (currentCount >= MAX_FIELDS_PER_MODULE) {
      const err = new Error(
        `Maximum ${MAX_FIELDS_PER_MODULE} custom fields per module reached`,
      );
      err.statusCode = 400;
      throw err;
    }

    // ── Ensure cf_ prefix ───────────────────────────────
    if (data.apiName && !data.apiName.startsWith("cf_")) {
      data.apiName = `cf_${data.apiName}`;
    }

    // ── Duplicate check ─────────────────────────────────
    const existing = await CustomField.findOne({
      tenantId,
      moduleApiName: data.moduleApiName,
      apiName: data.apiName,
      deletedAt: null,
    });
    if (existing) {
      const err = new Error(
        `Field "${data.apiName}" already exists on module "${data.moduleApiName}"`,
      );
      err.statusCode = 409;
      throw err;
    }

    // ── Type-specific validations ───────────────────────
    if (["select", "multiselect"].includes(data.fieldType)) {
      if (!data.options || data.options.length === 0) {
        const err = new Error(
          "Options are required for select/multiselect fields",
        );
        err.statusCode = 400;
        throw err;
      }
    }

    if (data.fieldType === "reference") {
      if (!data.referenceConfig?.targetModule) {
        const err = new Error(
          "referenceConfig.targetModule is required for reference fields",
        );
        err.statusCode = 400;
        throw err;
      }
    }

    if (["lookup", "user_lookup"].includes(data.fieldType)) {
      if (!data.lookupConfig?.targetModule) {
        const err = new Error(
          "lookupConfig.targetModule is required for lookup fields",
        );
        err.statusCode = 400;
        throw err;
      }
    }

    // ── Auto sort order ─────────────────────────────────
    if (data.sortOrder == null) {
      const maxSort = await CustomField.findOne({
        tenantId,
        moduleApiName: data.moduleApiName,
        deletedAt: null,
      })
        .sort("-sortOrder")
        .select("sortOrder")
        .lean();
      data.sortOrder = (maxSort?.sortOrder ?? -1) + 1;
    }

    const field = await CustomField.create({ ...data, tenantId });

    // Invalidate cache for this module
    customFieldCache.invalidate(tenantId, data.moduleApiName);

    setImmediate(() =>
      AuditLog.record({
        tenantId,
        userId: user._id,
        action: "custom_field.create",
        entityType: "custom_field",
        entityId: field._id,
        description: `Custom field created: ${field.label} (${field.apiName}) on ${field.moduleApiName}`,
        ipAddress: user._ipAddress,
        userAgent: user._userAgent,
        requestId: user._requestId,
      }),
    );

    return field;
  },

  /**
   * Update a custom field (apiName, moduleApiName, fieldType are immutable).
   */
  async update(tenantId, fieldId, data, user) {
    const field = await CustomField.findOne({
      _id: fieldId,
      tenantId,
      deletedAt: null,
    });
    if (!field) return null;

    // Immutable keys
    delete data.apiName;
    delete data.moduleApiName;
    delete data.fieldType;

    Object.assign(field, data);
    await field.save();

    // Invalidate cache for this module
    customFieldCache.invalidate(tenantId, field.moduleApiName);

    setImmediate(() =>
      AuditLog.record({
        tenantId,
        userId: user._id,
        action: "custom_field.update",
        entityType: "custom_field",
        entityId: field._id,
        description: `Custom field updated: ${field.label} (${field.apiName})`,
        metadata: { updatedFields: Object.keys(data) },
        ipAddress: user._ipAddress,
        userAgent: user._userAgent,
        requestId: user._requestId,
      }),
    );

    return field;
  },

  /**
   * Soft delete a custom field.
   */
  async softDelete(tenantId, fieldId, user) {
    const field = await CustomField.findOne({
      _id: fieldId,
      tenantId,
      deletedAt: null,
    });
    if (!field) return null;

    field.deletedAt = new Date();
    field.deletedBy = user._id;
    await field.save();

    // Invalidate cache for this module
    customFieldCache.invalidate(tenantId, field.moduleApiName);

    setImmediate(() =>
      AuditLog.record({
        tenantId,
        userId: user._id,
        action: "custom_field.delete",
        entityType: "custom_field",
        entityId: field._id,
        description: `Custom field deleted: ${field.label} (${field.apiName})`,
        ipAddress: user._ipAddress,
        userAgent: user._userAgent,
        requestId: user._requestId,
      }),
    );

    return field;
  },

  /**
   * Restore a soft-deleted custom field.
   */
  async restore(tenantId, fieldId, user) {
    const field = await CustomField.findOne({
      _id: fieldId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!field) return null;

    field.deletedAt = null;
    field.deletedBy = null;
    await field.save();

    // Invalidate cache for this module
    customFieldCache.invalidate(tenantId, field.moduleApiName);

    setImmediate(() =>
      AuditLog.record({
        tenantId,
        userId: user._id,
        action: "custom_field.restore",
        entityType: "custom_field",
        entityId: field._id,
        description: `Custom field restored: ${field.label}`,
        ipAddress: user._ipAddress,
        userAgent: user._userAgent,
        requestId: user._requestId,
      }),
    );

    return field;
  },

  /**
   * Reorder fields within a module.
   * @param {Array} fieldOrders - Array of { fieldId, sortOrder }
   */
  async reorder(tenantId, moduleApiName, fieldOrders, user) {
    const bulkOps = fieldOrders.map(({ fieldId, sortOrder }) => ({
      updateOne: {
        filter: { _id: fieldId, tenantId, moduleApiName, deletedAt: null },
        update: { $set: { sortOrder } },
      },
    }));

    const result = await CustomField.bulkWrite(bulkOps);

    // Invalidate cache for this module
    customFieldCache.invalidate(tenantId, moduleApiName);

    setImmediate(() =>
      AuditLog.record({
        tenantId,
        userId: user._id,
        action: "custom_field.reorder",
        entityType: "custom_field",
        description: `Custom fields reordered on ${moduleApiName}`,
        metadata: { moduleApiName, fieldCount: fieldOrders.length },
        ipAddress: user._ipAddress,
        userAgent: user._userAgent,
        requestId: user._requestId,
      }),
    );

    return result;
  },

  // ═══════════════════════════════════════════════════════
  // VALIDATION ENGINE
  // ═══════════════════════════════════════════════════════

  /**
   * Validate custom data against field definitions.
   * Enforces:
   *  - No nested objects (flat values only)
   *  - Required (static + conditional)
   *  - Type-specific checks (email, url, number range, etc.)
   *  - Generic validation rules (min, max, regex)
   *
   * @param {ObjectId} tenantId
   * @param {string}   moduleApiName
   * @param {Object}   customData - key→value map from the client
   * @param {string}   [userRole] - for role-based visibility filtering
   * @returns {{ valid: boolean, errors: string[] }}
   */
  async validateCustomData(
    tenantId,
    moduleApiName,
    customData,
    userRole = null,
  ) {
    const timer = startTimer("validateCustomData", {
      tenantId: String(tenantId),
      moduleApiName,
    });
    const fields = await this.getByModule(tenantId, moduleApiName, userRole);
    const errors = [];

    // ── Reject unknown keys not defined in field schema ─
    if (customData && typeof customData === "object") {
      const definedKeys = new Set(fields.map((f) => f.apiName));
      for (const key of Object.keys(customData)) {
        if (!definedKeys.has(key)) {
          errors.push(`Unknown custom field: "${key}"`);
        }
      }
      if (errors.length > 0) {
        timer.end();
        return { valid: false, errors };
      }
    }

    for (const field of fields) {
      const value = customData?.[field.apiName];

      // ── No nested objects ──────────────────────────────
      if (
        value !== null &&
        value !== undefined &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        errors.push(`${field.label}: nested objects are not allowed`);
        continue;
      }

      // ── Conditional required check ─────────────────────
      const condRequired = this._evaluateConditionalRequired(field, customData);

      // ── Required check (static OR conditional) ─────────
      const isEmpty = value === undefined || value === null || value === "";
      if ((field.isRequired || condRequired) && isEmpty) {
        errors.push(`${field.label} is required`);
        continue;
      }

      if (isEmpty) continue;

      // ── Generic validation rules ───────────────────────
      const vr = field.validation || {};
      if (vr.min != null && typeof value === "number" && value < vr.min) {
        errors.push(`${field.label} must be >= ${vr.min}`);
      }
      if (vr.max != null && typeof value === "number" && value > vr.max) {
        errors.push(`${field.label} must be <= ${vr.max}`);
      }
      if (vr.regex && typeof value === "string") {
        try {
          if (!new RegExp(vr.regex).test(value)) {
            errors.push(
              vr.regexMessage ||
                `${field.label} does not match required pattern`,
            );
          }
        } catch {
          // Invalid regex stored — skip rather than crash
        }
      }

      // ── Type-specific validation ───────────────────────
      switch (field.fieldType) {
        case "email":
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.push(`${field.label} must be a valid email`);
          }
          break;
        case "url":
          try {
            new URL(value);
          } catch {
            errors.push(`${field.label} must be a valid URL`);
          }
          break;
        case "number":
        case "currency":
        case "percent":
          if (typeof value !== "number" || isNaN(value)) {
            errors.push(`${field.label} must be a number`);
          } else {
            if (
              field.numberConfig?.min != null &&
              value < field.numberConfig.min
            ) {
              errors.push(
                `${field.label} must be >= ${field.numberConfig.min}`,
              );
            }
            if (
              field.numberConfig?.max != null &&
              value > field.numberConfig.max
            ) {
              errors.push(
                `${field.label} must be <= ${field.numberConfig.max}`,
              );
            }
          }
          break;
        case "select":
          if (field.options?.length) {
            const validVals = field.options.map((o) => o.value);
            if (!validVals.includes(value)) {
              errors.push(`${field.label}: invalid option "${value}"`);
            }
          }
          break;
        case "multiselect":
          if (!Array.isArray(value)) {
            errors.push(`${field.label} must be an array`);
          } else if (field.options?.length) {
            const validVals = field.options.map((o) => o.value);
            const invalid = value.filter((v) => !validVals.includes(v));
            if (invalid.length) {
              errors.push(
                `${field.label}: invalid options: ${invalid.join(", ")}`,
              );
            }
          }
          break;
        case "boolean":
          if (typeof value !== "boolean") {
            errors.push(`${field.label} must be a boolean`);
          }
          break;
        case "text":
        case "textarea":
          if (typeof value !== "string") {
            errors.push(`${field.label} must be a string`);
          } else {
            if (
              field.textConfig?.minLength &&
              value.length < field.textConfig.minLength
            ) {
              errors.push(
                `${field.label} must be at least ${field.textConfig.minLength} characters`,
              );
            }
            if (
              field.textConfig?.maxLength &&
              value.length > field.textConfig.maxLength
            ) {
              errors.push(
                `${field.label} must be at most ${field.textConfig.maxLength} characters`,
              );
            }
            if (field.textConfig?.pattern) {
              try {
                if (!new RegExp(field.textConfig.pattern).test(value)) {
                  errors.push(`${field.label} does not match required pattern`);
                }
              } catch {
                // skip invalid regex
              }
            }
          }
          break;
        case "phone":
          if (
            typeof value !== "string" ||
            !/^\+?[\d\s\-()]{7,20}$/.test(value)
          ) {
            errors.push(`${field.label} must be a valid phone number`);
          }
          break;
        case "date":
        case "datetime":
          if (isNaN(Date.parse(value))) {
            errors.push(`${field.label} must be a valid date`);
          }
          break;
        case "reference":
          // Must be a valid ObjectId string
          if (
            typeof value !== "string" ||
            !mongoose.Types.ObjectId.isValid(value)
          ) {
            errors.push(`${field.label} must be a valid reference ID`);
          }
          break;
        case "lookup":
        case "user_lookup":
          if (
            typeof value !== "string" ||
            !mongoose.Types.ObjectId.isValid(value)
          ) {
            errors.push(`${field.label} must be a valid lookup ID`);
          }
          break;
        default:
          break;
      }
    }

    timer.end("VALIDATION_WARN");
    return { valid: errors.length === 0, errors };
  },

  // ═══════════════════════════════════════════════════════
  // CONDITIONAL REQUIRED ENGINE
  // ═══════════════════════════════════════════════════════

  /**
   * Evaluate conditional required rules.
   * Returns true if ALL conditions match → field becomes required.
   *
   * Rule format: { field: "cf_status", operator: "eq", value: "active" }
   * Operators: eq, neq, in, nin, exists, gt, lt, gte, lte
   */
  _evaluateConditionalRequired(field, customData) {
    const rules = field.validation?.conditionalRequired;
    if (!rules || rules.length === 0) return false;

    return rules.every((rule) => {
      const fieldVal = customData?.[rule.field];
      switch (rule.operator) {
        case "eq":
          return fieldVal === rule.value;
        case "neq":
          return fieldVal !== rule.value;
        case "in":
          return Array.isArray(rule.value) && rule.value.includes(fieldVal);
        case "nin":
          return Array.isArray(rule.value) && !rule.value.includes(fieldVal);
        case "exists":
          return rule.value
            ? fieldVal !== undefined && fieldVal !== null && fieldVal !== ""
            : fieldVal === undefined || fieldVal === null || fieldVal === "";
        case "gt":
          return typeof fieldVal === "number" && fieldVal > rule.value;
        case "lt":
          return typeof fieldVal === "number" && fieldVal < rule.value;
        case "gte":
          return typeof fieldVal === "number" && fieldVal >= rule.value;
        case "lte":
          return typeof fieldVal === "number" && fieldVal <= rule.value;
        default:
          return false;
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  // REFERENCE FIELD RESOLVER (safe 1-level join)
  // ═══════════════════════════════════════════════════════

  /**
   * Resolve reference/lookup fields on a record's customData.
   * Performs a safe 1-level-only population — no recursive joins.
   *
   * @param {ObjectId} tenantId
   * @param {string}   moduleApiName
   * @param {Object}   customData - the record's customData map
   * @returns {Object}  Resolved data with `_resolved` appended to ref keys
   *
   * Example: { cf_account_ref: "64abc..." } →
   *          { cf_account_ref: "64abc...", cf_account_ref_resolved: { _id, name } }
   */
  async resolveReferences(tenantId, moduleApiName, customData, depth = 1) {
    if (!customData || typeof customData !== "object") return customData;

    // Enforce max depth = 1 (no recursive joins)
    const depthCheck = checkReferenceDepth(depth);
    if (!depthCheck.allowed) return customData;

    const timer = startTimer("resolveReferences", {
      tenantId: String(tenantId),
      moduleApiName,
    });
    const fields = await this.getByModule(tenantId, moduleApiName);
    const refFields = fields.filter((f) =>
      ["reference", "lookup", "user_lookup"].includes(f.fieldType),
    );

    if (refFields.length === 0) return customData;

    const resolved = { ...customData };

    for (const field of refFields) {
      const refId = customData[field.apiName];
      if (!refId || !mongoose.Types.ObjectId.isValid(refId)) continue;

      try {
        const targetModule =
          field.fieldType === "reference"
            ? field.referenceConfig?.targetModule
            : field.lookupConfig?.targetModule;

        if (!targetModule) continue;

        // Resolve the model name
        let modelName;
        if (field.fieldType === "user_lookup") {
          modelName = "User";
        } else {
          modelName = MODULE_MODEL_MAP[targetModule];
        }

        if (!modelName) continue;

        const Model = mongoose.model(modelName);
        const displayField =
          field.fieldType === "reference"
            ? field.referenceConfig?.displayField || "name"
            : field.lookupConfig?.displayField || "name";

        // Safe 1-level query — no populate, only selected fields
        const refDoc = await Model.findOne({
          _id: refId,
          tenantId,
          deletedAt: null,
        })
          .select(`_id ${displayField}`)
          .lean();

        if (refDoc) {
          resolved[`${field.apiName}_resolved`] = refDoc;
        }
      } catch {
        // Model not found or query error — skip silently
      }
    }

    timer.end("FIELD_RESOLUTION_WARN");
    return resolved;
  },

  /**
   * Bulk-resolve references for an array of records.
   * Batches IDs per target model for efficiency.
   */
  async bulkResolveReferences(tenantId, moduleApiName, records) {
    if (!records?.length) return records;

    const timer = startTimer("bulkResolveReferences", {
      tenantId: String(tenantId),
      moduleApiName,
      recordCount: records.length,
    });
    const fields = await this.getByModule(tenantId, moduleApiName);
    const refFields = fields.filter((f) =>
      ["reference", "lookup", "user_lookup"].includes(f.fieldType),
    );
    if (refFields.length === 0) return records;

    // Collect all IDs per model for batch queries
    const batches = new Map(); // modelName → { displayField, ids: Set }

    for (const field of refFields) {
      const targetModule =
        field.fieldType === "reference"
          ? field.referenceConfig?.targetModule
          : field.lookupConfig?.targetModule;
      if (!targetModule) continue;

      const modelName =
        field.fieldType === "user_lookup"
          ? "User"
          : MODULE_MODEL_MAP[targetModule];
      if (!modelName) continue;

      const displayField =
        field.fieldType === "reference"
          ? field.referenceConfig?.displayField || "name"
          : field.lookupConfig?.displayField || "name";

      if (!batches.has(modelName)) {
        batches.set(modelName, { displayField, ids: new Set() });
      }

      for (const record of records) {
        const cd =
          record.customData instanceof Map
            ? Object.fromEntries(record.customData)
            : record.customData || {};
        const refId = cd[field.apiName];
        if (refId && mongoose.Types.ObjectId.isValid(refId)) {
          batches.get(modelName).ids.add(String(refId));
        }
      }
    }

    // Execute batch queries
    const resolvedMap = new Map(); // id string → doc

    for (const [modelName, batch] of batches) {
      if (batch.ids.size === 0) continue;
      try {
        const Model = mongoose.model(modelName);
        const docs = await Model.find({
          _id: { $in: [...batch.ids] },
          tenantId,
          deletedAt: null,
        })
          .select(`_id ${batch.displayField}`)
          .lean();
        for (const doc of docs) {
          resolvedMap.set(String(doc._id), doc);
        }
      } catch {
        // skip
      }
    }

    // Attach resolved values
    timer.end("BULK_RESOLUTION_WARN");
    return records.map((record) => {
      const cd =
        record.customData instanceof Map
          ? Object.fromEntries(record.customData)
          : record.customData || {};
      const resolved = { ...cd };

      for (const field of refFields) {
        const refId = cd[field.apiName];
        if (refId && resolvedMap.has(String(refId))) {
          resolved[`${field.apiName}_resolved`] = resolvedMap.get(
            String(refId),
          );
        }
      }

      return { ...record, customData: resolved };
    });
  },

  // ═══════════════════════════════════════════════════════
  // SEARCHABLE INDEX
  // ═══════════════════════════════════════════════════════

  /**
   * Build a flat searchIndex object from customData for indexed/searchable fields.
   * This object is stored on the parent record for efficient $text or regex queries.
   *
   * @param {ObjectId} tenantId
   * @param {string}   moduleApiName
   * @param {Object}   customData
   * @returns {Object}  Flat { cf_xxx: value } only for searchable/indexed fields
   */
  async buildSearchIndex(tenantId, moduleApiName, customData) {
    if (!customData) return {};

    const timer = startTimer("buildSearchIndex", {
      tenantId: String(tenantId),
      moduleApiName,
    });
    const fields = await this.getByModule(tenantId, moduleApiName);
    const index = {};

    for (const field of fields) {
      if (!field.isSearchable && !field.isIndexed) continue;
      const val = customData[field.apiName];
      if (val === undefined || val === null) continue;

      // Only index flat primitives
      if (typeof val === "object" && !Array.isArray(val)) continue;

      // Convert arrays to comma-separated for text search
      index[field.apiName] = Array.isArray(val) ? val.join(",") : val;
    }

    timer.end("SEARCH_INDEX_WARN");
    return index;
  },

  // ═══════════════════════════════════════════════════════
  // SAFE FILTER BUILDER (safeguards)
  // ═══════════════════════════════════════════════════════

  /**
   * Build a safe Mongo filter fragment from user-supplied custom field params.
   * Only indexed fields are filterable. Max conditions enforced.
   *
   * @param {ObjectId} tenantId
   * @param {string}   moduleApiName
   * @param {Object}   filterParams - e.g. { cf_company: "acme", cf_revenue_gte: 1000 }
   * @returns {{ filter: Object, errors: string[] }}
   */
  async buildSafeFilter(tenantId, moduleApiName, filterParams) {
    const fields = await this.getByModule(tenantId, moduleApiName);
    return buildSafeCustomFilter(fields, filterParams);
  },

  /**
   * Return cache statistics for monitoring/debugging.
   */
  getCacheStats() {
    return customFieldCache.stats();
  },

  /**
   * Forcefully clear the field definition cache.
   */
  clearCache() {
    customFieldCache.clear();
  },
};

export default CustomFieldService;
