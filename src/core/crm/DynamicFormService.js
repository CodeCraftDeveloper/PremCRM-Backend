import FormDefinition from "../../models/crm/FormDefinition.js";
import CustomField from "../../models/crm/CustomField.js";
import AuditLog from "../../models/AuditLog.js";
import { sanitizeUpdatePayload } from "../../utils/sanitizePayload.js";
import { enforcePagination } from "../../utils/pagination.js";
import {
  buildSafeSearch,
  buildSafeSort,
} from "../../utils/safeQueryBuilder.js";

const FORM_SORT_FIELDS = [
  "name",
  "apiName",
  "formType",
  "submissionCount",
  "createdAt",
  "updatedAt",
];

/**
 * DynamicFormService — CRUD + submission handling for form definitions.
 * Supports public, internal, and embedded forms.
 * All operations are tenant-scoped.
 */
const DynamicFormService = {
  /**
   * List form definitions with optional filters.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      moduleApiName,
      formType,
      search,
      isActive,
      sort,
    } = {},
  ) {
    const { page, limit, skip } = enforcePagination(
      { page: rawPage, limit: rawLimit },
      50,
    );
    const safeSort = buildSafeSort(sort, FORM_SORT_FIELDS, "-createdAt");

    const filter = { tenantId, deletedAt: null };
    if (moduleApiName) filter.moduleApiName = moduleApiName;
    if (formType) filter.formType = formType;
    if (typeof isActive === "boolean") filter.isActive = isActive;
    if (search) {
      const safeSearch = buildSafeSearch(search);
      if (safeSearch) {
        filter.$or = [{ name: safeSearch }, { apiName: safeSearch }];
      }
    }

    const [forms, totalDocs] = await Promise.all([
      FormDefinition.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("createdBy", "name email")
        .lean(),
      FormDefinition.countDocuments(filter),
    ]);

    return {
      forms,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  /**
   * Get a single form definition by ID.
   */
  async getById(tenantId, formId) {
    return FormDefinition.findOne({
      _id: formId,
      tenantId,
      deletedAt: null,
    }).populate("createdBy", "name email");
  },

  /**
   * Get form by apiName (used for public form access).
   */
  async getByApiName(tenantId, apiName) {
    return FormDefinition.findOne({
      tenantId,
      apiName,
      deletedAt: null,
      isActive: true,
    }).lean();
  },

  /**
   * Get public form definition (no auth required).
   * Tenant-scoped via slug to prevent cross-tenant leaks.
   * Returns stripped-down version safe for public use.
   */
  async getPublicForm(tenantSlug, apiName) {
    const Tenant = (await import("../../models/Tenant.js")).default;
    const tenant = await Tenant.findOne({ slug: tenantSlug, isActive: true })
      .select("_id")
      .lean();
    if (!tenant) return null;

    const form = await FormDefinition.findOne({
      tenantId: tenant._id,
      apiName,
      formType: "public",
      isActive: true,
      deletedAt: null,
    })
      .select(
        "name apiName moduleApiName fieldMappings settings.submitLabel settings.successMessage settings.redirectUrl settings.theme settings.captchaEnabled",
      )
      .lean();

    return form;
  },

  /**
   * Create a new form definition.
   */
  async create(tenantId, data, user) {
    // Check duplicate apiName
    const existing = await FormDefinition.findOne({
      tenantId,
      apiName: data.apiName,
      deletedAt: null,
    });
    if (existing) {
      const err = new Error(
        `Form with apiName "${data.apiName}" already exists`,
      );
      err.statusCode = 409;
      throw err;
    }

    // Validate field mappings against module's custom fields
    if (data.fieldMappings?.length) {
      await this._validateFieldMappings(
        tenantId,
        data.moduleApiName,
        data.fieldMappings,
      );
    }

    const form = await FormDefinition.create({
      ...data,
      tenantId,
      createdBy: user._id,
    });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "form_definition.create",
      entityType: "form_definition",
      entityId: form._id,
      description: `Form created: ${form.name} (${form.formType})`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return form;
  },

  /**
   * Update a form definition.
   */
  async update(tenantId, formId, data, user) {
    const form = await FormDefinition.findOne({
      _id: formId,
      tenantId,
      deletedAt: null,
    });
    if (!form) return null;

    // apiName and moduleApiName are immutable
    delete data.apiName;
    delete data.moduleApiName;

    data = sanitizeUpdatePayload("forms", data, user.role);

    // Validate updated field mappings
    if (data.fieldMappings?.length) {
      await this._validateFieldMappings(
        tenantId,
        form.moduleApiName,
        data.fieldMappings,
      );
    }

    Object.assign(form, data);
    await form.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "form_definition.update",
      entityType: "form_definition",
      entityId: form._id,
      description: `Form updated: ${form.name}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return form;
  },

  /**
   * Soft delete a form definition.
   */
  async softDelete(tenantId, formId, user) {
    const form = await FormDefinition.findOne({
      _id: formId,
      tenantId,
      deletedAt: null,
    });
    if (!form) return null;

    form.deletedAt = new Date();
    form.deletedBy = user._id;
    await form.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "form_definition.delete",
      entityType: "form_definition",
      entityId: form._id,
      description: `Form deleted: ${form.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return form;
  },

  /**
   * Restore a soft-deleted form.
   */
  async restore(tenantId, formId, user) {
    const form = await FormDefinition.findOne({
      _id: formId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!form) return null;

    form.deletedAt = null;
    form.deletedBy = null;
    await form.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "form_definition.restore",
      entityType: "form_definition",
      entityId: form._id,
      description: `Form restored: ${form.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return form;
  },

  /**
   * Record a form submission (increment counter + timestamp).
   * Called after a record is successfully created via this form.
   */
  async recordSubmission(tenantId, formId) {
    await FormDefinition.findOneAndUpdate(
      { _id: formId, tenantId, deletedAt: null },
      {
        $inc: { submissionCount: 1 },
        $set: { lastSubmissionAt: new Date() },
      },
    );
  },

  /**
   * Duplicate a form definition.
   */
  async duplicate(tenantId, formId, newName, user) {
    const original = await FormDefinition.findOne({
      _id: formId,
      tenantId,
      deletedAt: null,
    }).lean();
    if (!original) return null;

    delete original._id;
    delete original.createdAt;
    delete original.updatedAt;

    const timestamp = Date.now();
    const form = await FormDefinition.create({
      ...original,
      name: newName || `${original.name} (Copy)`,
      apiName: `${original.apiName}_copy_${timestamp}`,
      submissionCount: 0,
      lastSubmissionAt: null,
      createdBy: user._id,
    });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "form_definition.duplicate",
      entityType: "form_definition",
      entityId: form._id,
      description: `Form duplicated: ${form.name} from ${original.apiName}`,
      metadata: { originalFormId: formId },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return form;
  },

  /**
   * Internal: validate field mappings against actual custom fields.
   */
  async _validateFieldMappings(tenantId, moduleApiName, fieldMappings) {
    // Get all active custom fields for this module
    const fields = await CustomField.find({
      tenantId,
      moduleApiName,
      deletedAt: null,
      isActive: true,
    })
      .select("apiName label")
      .lean();

    const fieldApiNames = new Set(fields.map((f) => f.apiName));

    // Also allow built-in field names (not prefixed with cf_)
    const invalid = fieldMappings.filter(
      (fm) =>
        fm.fieldApiName.startsWith("cf_") &&
        !fieldApiNames.has(fm.fieldApiName),
    );

    if (invalid.length > 0) {
      const err = new Error(
        `Invalid custom field references: ${invalid.map((f) => f.fieldApiName).join(", ")}`,
      );
      err.statusCode = 400;
      throw err;
    }
  },
};

export default DynamicFormService;
