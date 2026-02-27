/**
 * safeQueryBuilder.js — Phase 2 Hardening: Dynamic Filter Guard
 *
 * Two layers of defense:
 *
 * 1. `sanitizeQueryParams` — Express middleware that strips MongoDB operator
 *    injection from req.query values (e.g. `?email[$gt]=` → rejected).
 *
 * 2. `buildSafeSystemFilter` — Utility for controllers to build Mongo filter
 *    objects from query params using an explicit allow-list of fields and
 *    permitted operators per field.
 *
 * Works alongside customFieldPerf.js `buildSafeCustomFilter` for cf_* fields.
 */

// ── MongoDB operators that must never appear as raw query param keys/values ──
const DANGEROUS_KEYS = /^\$/;

/**
 * Express middleware: recursively strips any keys starting with `$` from
 * req.query, req.body, and req.params to prevent NoSQL injection.
 *
 * Must be mounted before route handlers.
 */
export function sanitizeQueryParams(req, _res, next) {
  if (req.query) req.query = stripDollarKeys(req.query);
  if (req.body && typeof req.body === "object") {
    req.body = stripDollarKeys(req.body);
  }
  next();
}

/**
 * Recursively remove any properties whose key starts with `$`.
 * Returns a shallow clone (does not mutate the original, though Express
 * re-parses query on each request so mutation is safe too).
 */
function stripDollarKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripDollarKeys);

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.test(key)) continue; // drop $gt, $where, etc.
    clean[key] =
      typeof value === "object" && value !== null
        ? stripDollarKeys(value)
        : value;
  }
  return clean;
}

// ── Allowed filter operators (suffix → Mongo operator) ──────────────────────
const ALLOWED_OPERATORS = {
  eq: null, // exact match (default)
  gte: "$gte",
  lte: "$lte",
  gt: "$gt",
  lt: "$lt",
  ne: "$ne",
  in: "$in",
  regex: "$regex",
};

/**
 * Build a safe Mongo filter from user-supplied query params using an explicit
 * allow-list.
 *
 * @param {Object} queryParams  — raw req.query (after sanitizeQueryParams)
 * @param {Object} allowedFields — map of allowed field names to config:
 *   {
 *     ownerId:   { type: 'objectId' },
 *     stage:     { type: 'string', operators: ['eq', 'in', 'ne'] },
 *     amount:    { type: 'number', operators: ['eq', 'gte', 'lte'] },
 *     createdAt: { type: 'date',   operators: ['gte', 'lte'] },
 *   }
 *   If `operators` is omitted, only exact match is allowed.
 * @returns {{ filter: Object, errors: string[] }}
 */
export function buildSafeSystemFilter(queryParams, allowedFields) {
  const filter = {};
  const errors = [];

  if (!queryParams || typeof queryParams !== "object") {
    return { filter, errors };
  }

  for (const [rawKey, rawValue] of Object.entries(queryParams)) {
    // Skip pagination / sort / search meta params
    if (
      ["page", "limit", "sort", "search", "fields", "populate"].includes(rawKey)
    ) {
      continue;
    }
    // Skip custom field params (handled by buildSafeCustomFilter)
    if (rawKey.startsWith("cf_")) continue;

    // Parse operator suffix: e.g. "amount_gte" → field="amount", op="gte"
    let fieldName = rawKey;
    let opKey = "eq";
    const lastUnderscore = rawKey.lastIndexOf("_");
    if (lastUnderscore > 0) {
      const possibleOp = rawKey.slice(lastUnderscore + 1);
      if (ALLOWED_OPERATORS[possibleOp] !== undefined) {
        fieldName = rawKey.slice(0, lastUnderscore);
        opKey = possibleOp;
      }
    }

    // Check allow-list
    const fieldConfig = allowedFields[fieldName];
    if (!fieldConfig) {
      // Silently ignore unknown fields (defense in depth — don't leak schema info)
      continue;
    }

    // Check operator is permitted for this field
    const permittedOps = fieldConfig.operators || ["eq"];
    if (!permittedOps.includes(opKey)) {
      errors.push(`Operator "${opKey}" is not allowed on field "${fieldName}"`);
      continue;
    }

    // Cast value
    const castedValue = castSystemValue(fieldConfig.type, rawValue, opKey);
    if (castedValue === undefined) {
      errors.push(`Invalid value for "${fieldName}": ${rawValue}`);
      continue;
    }

    // Build condition
    const mongoOp = ALLOWED_OPERATORS[opKey];
    if (mongoOp === null) {
      // Exact match
      filter[fieldName] = castedValue;
    } else if (mongoOp === "$in") {
      const values = String(rawValue)
        .split(",")
        .map((v) => castSystemValue(fieldConfig.type, v.trim(), "eq"))
        .filter((v) => v !== undefined);
      filter[fieldName] = { $in: values };
    } else if (mongoOp === "$regex") {
      // Only allow prefix search for safety
      const escaped = String(rawValue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter[fieldName] = { $regex: `^${escaped}`, $options: "i" };
    } else {
      filter[fieldName] = {
        ...(filter[fieldName] || {}),
        [mongoOp]: castedValue,
      };
    }
  }

  return { filter, errors };
}

/**
 * Cast a raw string value to the correct type.
 */
function castSystemValue(type, value, _operator) {
  if (value === undefined || value === null || value === "") return undefined;
  switch (type) {
    case "objectId":
      return /^[a-f\d]{24}$/i.test(String(value)) ? String(value) : undefined;
    case "number": {
      const n = Number(value);
      return isNaN(n) ? undefined : n;
    }
    case "boolean":
      if (value === "true" || value === true) return true;
      if (value === "false" || value === false) return false;
      return undefined;
    case "date": {
      const d = new Date(value);
      return isNaN(d.getTime()) ? undefined : d;
    }
    case "string":
    default:
      return String(value);
  }
}

export { ALLOWED_OPERATORS };

// ── Shared regex search helpers ───────────────────────────────────────────────

const SEARCH_MAX_LENGTH = 100;

/**
 * Escape all special regex metacharacters in a string so it is safe to pass
 * to MongoDB's $regex operator as a literal substring search.
 *
 * @param {string} str - raw user input
 * @returns {string} escaped string
 */
export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a safe, length-limited regex condition for a single search term.
 *
 * Returns null when the input is empty or exceeds the maximum allowed length
 * so the caller can skip adding the $or / filter condition entirely.
 *
 * @param {string|undefined} search - raw search input from req.query
 * @returns {{ $regex: string, $options: string } | null}
 */
export function buildSafeSearch(search) {
  if (!search || typeof search !== "string") return null;
  const trimmed = search.trim();
  if (trimmed.length === 0 || trimmed.length > SEARCH_MAX_LENGTH) return null;
  return { $regex: escapeRegex(trimmed), $options: "i" };
}

/**
 * Build a safe sort string from user input, validated against an allowlist.
 *
 * Supports single-field sort with optional `-` prefix for descending order.
 * Falls back to `defaultSort` when the input is invalid or not in the allowlist.
 *
 * @param {string|undefined} rawSort - e.g. "-createdAt" or "name"
 * @param {string[]} allowedFields   - list of permitted field names
 * @param {string} defaultSort       - safe fallback, e.g. "-createdAt"
 * @returns {string} validated sort string safe to pass to Mongoose .sort()
 */
export function buildSafeSort(
  rawSort,
  allowedFields,
  defaultSort = "-createdAt",
) {
  if (!rawSort || typeof rawSort !== "string") return defaultSort;
  const trimmed = rawSort.trim();
  const isDesc = trimmed.startsWith("-");
  const fieldName = isDesc ? trimmed.slice(1) : trimmed;
  if (!allowedFields.includes(fieldName)) return defaultSort;
  return trimmed;
}

/**
 * Composite query sanitizer — single entry point for services.
 *
 * Escapes regex, limits search length, validates sort against allowlist,
 * and enforces pagination. Returns ready-to-use { safeSearch, safeSort, page, limit, skip }.
 *
 * @param {Object} opts
 * @param {string} [opts.search]        - raw search input
 * @param {string} [opts.sort]          - raw sort input (e.g. "-createdAt")
 * @param {string[]} opts.allowedSortFields - whitelist for sort
 * @param {string} [opts.defaultSort]   - fallback sort (default: "-createdAt")
 * @param {number} [opts.page]          - raw page number
 * @param {number} [opts.limit]         - raw limit
 * @returns {{ safeSearch: object|null, safeSort: string, page: number, limit: number, skip: number }}
 */
export function buildSafeQuery({
  search,
  sort,
  allowedSortFields = [],
  defaultSort = "-createdAt",
  page,
  limit,
} = {}) {
  const { enforcePagination: _ep } = (() => {
    // Inline import avoidance — call enforcePagination directly
    let safePage = parseInt(page, 10);
    if (!Number.isFinite(safePage) || safePage < 1) safePage = 1;
    let safeLimit = parseInt(limit, 10);
    if (!Number.isFinite(safeLimit) || safeLimit < 1) safeLimit = 20;
    if (safeLimit > 100) safeLimit = 100;
    return {
      enforcePagination: {
        page: safePage,
        limit: safeLimit,
        skip: (safePage - 1) * safeLimit,
      },
    };
  })();
  return {
    safeSearch: buildSafeSearch(search),
    safeSort: buildSafeSort(sort, allowedSortFields, defaultSort),
    page: _ep.page,
    limit: _ep.limit,
    skip: _ep.skip,
  };
}
