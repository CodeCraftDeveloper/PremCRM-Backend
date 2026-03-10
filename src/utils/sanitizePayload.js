/**
 * sanitizePayload.js — Centralized mass-assignment protection.
 *
 * Blocks system/internal fields from being set via user-supplied payloads
 * in CRM create/update paths. Prevents privilege escalation and tenant
 * boundary violations through crafted request bodies.
 *
 * Usage:
 *   import { sanitizeUpdatePayload, sanitizeCreatePayload } from "../utils/sanitizePayload.js";
 *   data = sanitizeUpdatePayload("contacts", data, user.role);
 */

// ── Fields that are NEVER writable via API payload ──────────────────
const GLOBAL_BLOCKED_FIELDS = [
  "tenantId",
  "_id",
  "__v",
  "deletedAt",
  "deletedBy",
  "createdAt",
  "updatedAt",
  "createdBy",
  "searchIndex", // computed server-side
  "submissionCount", // computed server-side
  "lastSubmissionAt", // computed server-side
];

// ── Module-specific blocked fields ──────────────────────────────────
const MODULE_BLOCKED_FIELDS = {
  contacts: ["convertedFromLead"],
  accounts: ["convertedFromLead"],
  deals: [
    "stageHistory", // managed by changeStage flow
    "wonAt", // set via stage transition
    "lostAt", // set via stage transition
    "probability", // set via pipeline stage
    "convertedFromLead",
  ],
  activities: ["completedAt"], // set via status transition
  forms: ["submissionCount", "lastSubmissionAt"],
};

// ── Ownership fields: only admin can set these ──────────────────────
const OWNERSHIP_FIELDS = ["ownerId", "assignedTo"];

/**
 * Remove blocked/system fields from a payload object.
 *
 * @param {string} module - CRM module key (contacts|accounts|deals|activities|forms)
 * @param {object} payload - Raw request body
 * @param {string} role - User's role (admin|marketing|user)
 * @returns {object} - Sanitized payload (shallow clone, blocked keys removed)
 */
export function sanitizeUpdatePayload(module, payload, role = "user") {
  if (!payload || typeof payload !== "object") return {};

  const sanitized = { ...payload };

  // Remove globally blocked fields
  for (const field of GLOBAL_BLOCKED_FIELDS) {
    delete sanitized[field];
  }

  // Remove module-specific blocked fields
  const moduleBlocked = MODULE_BLOCKED_FIELDS[module] || [];
  for (const field of moduleBlocked) {
    delete sanitized[field];
  }

  // Block ownership field changes for non-admin roles
  // Ownership changes should go through dedicated assign endpoints
  if (role !== "admin") {
    for (const field of OWNERSHIP_FIELDS) {
      delete sanitized[field];
    }
  }

  return sanitized;
}

/**
 * Sanitize a create payload — same rules as update, but allows ownerId
 * since it needs to be set on creation.
 */
export function sanitizeCreatePayload(module, payload, _role = "user") {
  if (!payload || typeof payload !== "object") return {};

  const sanitized = { ...payload };

  // Remove globally blocked fields
  for (const field of GLOBAL_BLOCKED_FIELDS) {
    delete sanitized[field];
  }

  // Remove module-specific blocked fields
  const moduleBlocked = MODULE_BLOCKED_FIELDS[module] || [];
  for (const field of moduleBlocked) {
    delete sanitized[field];
  }

  // On create, allow ownerId/assignedTo since records need an initial owner
  // but still block tenantId — always set server-side

  return sanitized;
}
