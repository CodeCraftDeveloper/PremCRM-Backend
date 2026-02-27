import CustomFieldService from "./CustomFieldService.js";

/**
 * customDataHelper — Shared logic for validating and indexing
 * customData on CRM record create/update operations.
 *
 * Designed to be called inside any CRM service (Contact, Account, Deal, etc.)
 * without coupling those services to the metadata engine internals.
 *
 * Usage in a service:
 *   import { processCustomData } from "./customDataHelper.js";
 *
 *   async create(tenantId, data, user) {
 *     if (data.customData) {
 *       data = await processCustomData(tenantId, "contacts", data, user.role);
 *     }
 *     // ... proceed with normal create
 *   }
 */

/**
 * Validate + build searchIndex for incoming customData.
 * Throws (400) if validation fails.
 *
 * @param {ObjectId} tenantId
 * @param {string}   moduleApiName  - e.g. "contacts", "deals"
 * @param {Object}   data           - The full record data (must have .customData)
 * @param {string}   [userRole]     - For role-based visibility filtering
 * @returns {Object} data — with customData sanitized and searchIndex built
 */
export async function processCustomData(
  tenantId,
  moduleApiName,
  data,
  userRole = null,
) {
  if (!data.customData || typeof data.customData !== "object") {
    return data;
  }

  // Convert Map to plain object for validation
  const cdObj =
    data.customData instanceof Map
      ? Object.fromEntries(data.customData)
      : data.customData;

  // ── Validate ────────────────────────────────────────────
  const result = await CustomFieldService.validateCustomData(
    tenantId,
    moduleApiName,
    cdObj,
    userRole,
  );

  if (!result.valid) {
    const err = new Error(
      `Custom field validation failed: ${result.errors.join("; ")}`,
    );
    err.statusCode = 400;
    err.errors = result.errors;
    throw err;
  }

  // ── Build search index ─────────────────────────────────
  const searchIndex = await CustomFieldService.buildSearchIndex(
    tenantId,
    moduleApiName,
    cdObj,
  );

  return {
    ...data,
    customData: cdObj,
    searchIndex:
      Object.keys(searchIndex).length > 0 ? searchIndex : data.searchIndex,
  };
}

/**
 * Resolve reference fields on a single record after read.
 * Safe to call on any record — returns unchanged if no references exist.
 */
export async function resolveRecordReferences(tenantId, moduleApiName, record) {
  if (!record) return record;

  const cd =
    record.customData instanceof Map
      ? Object.fromEntries(record.customData)
      : record.customData;

  if (!cd || Object.keys(cd).length === 0) return record;

  const resolved = await CustomFieldService.resolveReferences(
    tenantId,
    moduleApiName,
    cd,
  );

  // Return a new object with resolved customData
  const output = record.toObject ? record.toObject() : { ...record };
  output.customData = resolved;
  return output;
}

/**
 * Bulk-resolve references for a list of records (e.g. list endpoints).
 */
export async function resolveListReferences(tenantId, moduleApiName, records) {
  if (!records?.length) return records;
  return CustomFieldService.bulkResolveReferences(
    tenantId,
    moduleApiName,
    records,
  );
}

/**
 * Filter customData on record(s) to only include fields visible to the given role.
 * Designed for read endpoints — strips fields the current user should not see.
 *
 * @param {ObjectId} tenantId
 * @param {string}   moduleApiName - e.g. "contacts", "deals"
 * @param {Object|Array} data - a single record or array of records
 * @param {string|null} userRole - the requesting user's role
 * @returns {Object|Array} data with customData filtered
 */
export async function filterCustomDataByRole(
  tenantId,
  moduleApiName,
  data,
  userRole,
) {
  if (!userRole || !data) return data;

  const fields = await CustomFieldService.getByModule(
    tenantId,
    moduleApiName,
    userRole,
  );
  const visibleKeys = new Set(fields.map((f) => f.apiName));

  const filterRecord = (record) => {
    if (!record?.customData) return record;
    const cd =
      record.customData instanceof Map
        ? Object.fromEntries(record.customData)
        : record.customData;

    if (!cd || typeof cd !== "object") return record;

    const filtered = {};
    for (const key of Object.keys(cd)) {
      if (visibleKeys.has(key)) filtered[key] = cd[key];
    }

    if (record.toObject) {
      const obj = record.toObject();
      obj.customData = filtered;
      return obj;
    }
    return { ...record, customData: filtered };
  };

  if (Array.isArray(data)) return data.map(filterRecord);
  return filterRecord(data);
}
