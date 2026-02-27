/**
 * tenantRefGuard.js — Cross-tenant reference injection prevention.
 *
 * Validates that all referenced ObjectIds (ownerId, accountId, contactId, etc.)
 * belong to the same tenant before a record is created or updated.
 *
 * Prevents an attacker from linking records to entities in another tenant
 * by injecting foreign ObjectIds into request payloads.
 *
 * Usage:
 *   import { assertTenantScopedRefs } from "../utils/tenantRefGuard.js";
 *   await assertTenantScopedRefs(tenantId, "contacts", data);
 */

import mongoose from "mongoose";
import User from "../models/User.js";
import Account from "../models/crm/Account.js";
import Contact from "../models/crm/Contact.js";
import Deal from "../models/crm/Deal.js";
import Pipeline from "../models/crm/Pipeline.js";

const {
  Types: { ObjectId },
} = mongoose;

/**
 * Map of reference field names → the model + tenant filter to check.
 * Each entry defines how to verify a given ID belongs to the tenant.
 */
const REF_REGISTRY = {
  ownerId: {
    model: () => User,
    tenantField: "tenantId",
    label: "Owner",
  },
  assignedTo: {
    model: () => User,
    tenantField: "tenantId",
    label: "Assigned user",
  },
  accountId: {
    model: () => Account,
    tenantField: "tenantId",
    label: "Account",
    extraFilter: { deletedAt: null },
  },
  contactId: {
    model: () => Contact,
    tenantField: "tenantId",
    label: "Contact",
    extraFilter: { deletedAt: null },
  },
  pipelineId: {
    model: () => Pipeline,
    tenantField: "tenantId",
    label: "Pipeline",
    extraFilter: { isActive: true },
  },
  parentAccountId: {
    model: () => Account,
    tenantField: "tenantId",
    label: "Parent account",
    extraFilter: { deletedAt: null },
  },
  "settings.defaultOwnerId": {
    model: () => User,
    tenantField: "tenantId",
    label: "Default owner",
  },
};

/**
 * Module → which reference fields to validate on that module.
 */
const MODULE_REFS = {
  contacts: ["ownerId", "accountId"],
  accounts: ["ownerId", "parentAccountId"],
  deals: ["ownerId", "contactId", "accountId", "pipelineId"],
  activities: ["ownerId"],
  forms: ["settings.defaultOwnerId"],
};

/**
 * Safely get a nested value from an object using dot-notation key.
 */
function getNestedValue(obj, key) {
  return key.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
}

/**
 * Validate that all reference IDs in a payload belong to the specified tenant.
 *
 * @param {ObjectId|string} tenantId - The tenant to validate against.
 * @param {string} module - CRM module key (contacts|accounts|deals|activities|forms).
 * @param {object} payload - The request body to check.
 * @throws {Error} 400 error with details of mismatched references.
 */
export async function assertTenantScopedRefs(tenantId, module, payload) {
  if (!payload || typeof payload !== "object") return;

  const refFields = MODULE_REFS[module];
  if (!refFields) return; // unknown module — skip

  const tenantStr = String(tenantId);
  const checks = [];

  for (const fieldKey of refFields) {
    const value = getNestedValue(payload, fieldKey);
    if (!value) continue; // field not present or null — skip

    // Validate it resembles a valid ObjectId
    if (!ObjectId.isValid(value)) {
      const err = new Error(`Invalid ${fieldKey}: not a valid ID`);
      err.statusCode = 400;
      throw err;
    }

    const refDef = REF_REGISTRY[fieldKey];
    if (!refDef) continue;

    checks.push({ fieldKey, value, refDef });
  }

  if (checks.length === 0) return;

  // Run all lookups in parallel for performance
  const results = await Promise.all(
    checks.map(async ({ fieldKey, value, refDef }) => {
      const filter = {
        _id: value,
        [refDef.tenantField]: tenantId,
        ...(refDef.extraFilter || {}),
      };
      const exists = await refDef.model().exists(filter);
      return { fieldKey, value, label: refDef.label, exists: !!exists };
    }),
  );

  const failures = results.filter((r) => !r.exists);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.label} (${f.fieldKey}=${f.value})`)
      .join(", ");
    const err = new Error(
      `Cross-tenant reference violation: ${details} not found in current tenant`,
    );
    err.statusCode = 400;
    throw err;
  }
}
