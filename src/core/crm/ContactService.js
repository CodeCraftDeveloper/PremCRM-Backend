import Contact from "../../models/crm/Contact.js";
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
import { buildSafeSearch, buildSafeSort } from "../../utils/safeQueryBuilder.js";

const CONTACT_SORT_FIELDS = [
  "fullName", "email", "phone", "createdAt", "updatedAt", "source",
];

/**
 * ContactService — CRUD + business logic for CRM Contacts.
 * All operations are tenant-scoped.
 */
const ContactService = {
  /**
   * List contacts with filters and pagination.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      ownerId,
      accountId,
      source,
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
    const safeSort = buildSafeSort(sortString, CONTACT_SORT_FIELDS, "-createdAt");

    const filter = { tenantId, deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (accountId) filter.accountId = accountId;
    if (source) filter.source = source;
    if (search) {
      const safeSearch = buildSafeSearch(search);
      if (safeSearch) {
        filter.$or = [
          { fullName: safeSearch },
          { email: safeSearch },
          { phone: safeSearch },
        ];
      }
    }

    const [contacts, totalDocs] = await Promise.all([
      Contact.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("ownerId", "name email")
        .populate("accountId", "name")
        .lean(),
      Contact.countDocuments(filter),
    ]);

    return {
      contacts,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  /**
   * Get a single contact by ID (tenant-scoped).
   * Auto-resolves reference fields in customData.
   */
  async getById(tenantId, contactId) {
    const contact = await Contact.findOne({
      _id: contactId,
      tenantId,
      deletedAt: null,
    })
      .populate("ownerId", "name email")
      .populate("accountId", "name industry");
    return resolveRecordReferences(tenantId, "contacts", contact);
  },

  /**
   * Create a new contact.
   */
  async create(tenantId, data, user) {
    data = sanitizeCreatePayload("contacts", data, user.role);
    if (!data.ownerId) {
      data.ownerId = user._id;
    }
    await assertTenantScopedRefs(tenantId, "contacts", data);

    // Validate & index custom data if present
    if (data.customData) {
      data = await processCustomData(tenantId, "contacts", data, user.role);
    }

    const contact = await Contact.create({ ...data, tenantId });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "contact.create",
      entityType: "contact",
      entityId: contact._id,
      description: `Contact created: ${contact.fullName || contact.firstName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return contact;
  },

  /**
   * Update a contact.
   */
  async update(tenantId, contactId, data, user) {
    const contact = await Contact.findOne({
      _id: contactId,
      tenantId,
      deletedAt: null,
    });
    if (!contact) return null;

    data = sanitizeUpdatePayload("contacts", data, user.role);
    await assertTenantScopedRefs(tenantId, "contacts", data);

    // Validate & index custom data if present
    if (data.customData) {
      data = await processCustomData(tenantId, "contacts", data, user.role);
    }

    Object.assign(contact, data);
    await contact.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "contact.update",
      entityType: "contact",
      entityId: contact._id,
      description: `Contact updated: ${contact.fullName || contact.firstName}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return contact;
  },

  /**
   * Soft delete a contact.
   */
  async softDelete(tenantId, contactId, user) {
    const contact = await Contact.findOne({
      _id: contactId,
      tenantId,
      deletedAt: null,
    });
    if (!contact) return null;

    contact.deletedAt = new Date();
    contact.deletedBy = user._id;
    await contact.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "contact.delete",
      entityType: "contact",
      entityId: contact._id,
      description: `Contact deleted: ${contact.fullName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return contact;
  },

  /**
   * Restore a soft-deleted contact.
   */
  async restore(tenantId, contactId, user) {
    const contact = await Contact.findOne({
      _id: contactId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!contact) return null;

    contact.deletedAt = null;
    contact.deletedBy = null;
    await contact.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "contact.restore",
      entityType: "contact",
      entityId: contact._id,
      description: `Contact restored: ${contact.fullName}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return contact;
  },

  /**
   * Assign owner to a contact.
   */
  async assignOwner(tenantId, contactId, newOwnerId, user) {
    // Prevent cross-tenant owner injection
    await assertTenantScopedRefs(tenantId, "contacts", { ownerId: newOwnerId });

    const contact = await Contact.findOne({
      _id: contactId,
      tenantId,
      deletedAt: null,
    });
    if (!contact) return null;

    const oldOwnerId = contact.ownerId;
    contact.ownerId = newOwnerId;
    await contact.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "contact.assign",
      entityType: "contact",
      entityId: contact._id,
      description: `Contact owner changed`,
      metadata: { oldOwnerId, newOwnerId },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return contact;
  },
};

export default ContactService;
