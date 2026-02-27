import Account from "../../models/crm/Account.js";
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
import { buildSafeSearch, escapeRegex, buildSafeSort } from "../../utils/safeQueryBuilder.js";

const ACCOUNT_SORT_FIELDS = [
  "name", "email", "type", "industry", "createdAt", "updatedAt",
];

/**
 * AccountService — CRUD + business logic for CRM Accounts (Companies).
 */
const AccountService = {
  /**
   * List accounts with filters and pagination.
   */
  async list(
    tenantId,
    {
      page: rawPage,
      limit: rawLimit,
      ownerId,
      type,
      industry,
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
    const safeSort = buildSafeSort(sortString, ACCOUNT_SORT_FIELDS, "-createdAt");

    const filter = { tenantId, deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (type) filter.type = type;
    if (industry) {
      const safeIndustry = buildSafeSearch(industry);
      if (safeIndustry) filter.industry = safeIndustry;
    }
    if (search) {
      const safeSearch = buildSafeSearch(search);
      if (safeSearch) {
        filter.$or = [
          { name: safeSearch },
          { email: safeSearch },
        ];
      }
    }

    const [accounts, totalDocs] = await Promise.all([
      Account.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate("ownerId", "name email")
        .lean(),
      Account.countDocuments(filter),
    ]);

    return {
      accounts,
      pagination: {
        page,
        limit,
        totalDocs,
        totalPages: Math.ceil(totalDocs / limit),
      },
    };
  },

  async getById(tenantId, accountId) {
    const account = await Account.findOne({
      _id: accountId,
      tenantId,
      deletedAt: null,
    })
      .populate("ownerId", "name email")
      .populate("parentAccountId", "name");
    return resolveRecordReferences(tenantId, "accounts", account);
  },

  async create(tenantId, data, user) {
    data = sanitizeCreatePayload("accounts", data, user.role);
    if (!data.ownerId) {
      data.ownerId = user._id;
    }
    await assertTenantScopedRefs(tenantId, "accounts", data);

    if (data.customData) {
      data = await processCustomData(tenantId, "accounts", data, user.role);
    }
    const account = await Account.create({ ...data, tenantId });

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "account.create",
      entityType: "account",
      entityId: account._id,
      description: `Account created: ${account.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return account;
  },

  async update(tenantId, accountId, data, user) {
    const account = await Account.findOne({
      _id: accountId,
      tenantId,
      deletedAt: null,
    });
    if (!account) return null;

    data = sanitizeUpdatePayload("accounts", data, user.role);
    await assertTenantScopedRefs(tenantId, "accounts", data);

    if (data.customData) {
      data = await processCustomData(tenantId, "accounts", data, user.role);
    }

    Object.assign(account, data);
    await account.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "account.update",
      entityType: "account",
      entityId: account._id,
      description: `Account updated: ${account.name}`,
      metadata: { updatedFields: Object.keys(data) },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return account;
  },

  async softDelete(tenantId, accountId, user) {
    const account = await Account.findOne({
      _id: accountId,
      tenantId,
      deletedAt: null,
    });
    if (!account) return null;

    account.deletedAt = new Date();
    account.deletedBy = user._id;
    await account.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "account.delete",
      entityType: "account",
      entityId: account._id,
      description: `Account deleted: ${account.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return account;
  },

  async restore(tenantId, accountId, user) {
    const account = await Account.findOne({
      _id: accountId,
      tenantId,
      deletedAt: { $ne: null },
    });
    if (!account) return null;

    account.deletedAt = null;
    account.deletedBy = null;
    await account.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "account.restore",
      entityType: "account",
      entityId: account._id,
      description: `Account restored: ${account.name}`,
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return account;
  },

  async assignOwner(tenantId, accountId, newOwnerId, user) {
    // Prevent cross-tenant owner injection
    await assertTenantScopedRefs(tenantId, "accounts", { ownerId: newOwnerId });

    const account = await Account.findOne({
      _id: accountId,
      tenantId,
      deletedAt: null,
    });
    if (!account) return null;

    const oldOwnerId = account.ownerId;
    account.ownerId = newOwnerId;
    await account.save();

    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "account.assign",
      entityType: "account",
      entityId: account._id,
      description: `Account owner changed`,
      metadata: { oldOwnerId, newOwnerId },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return account;
  },
};

export default AccountService;
