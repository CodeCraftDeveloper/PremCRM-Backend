import logger from "../../utils/logger.js";

/**
 * customFieldPerf — Performance monitoring for Dynamic Metadata Engine.
 *
 * Provides:
 *  1. Timer utility for measuring operation duration
 *  2. Warning thresholds for slow operations
 *  3. Safe custom-field filter builder with safeguards
 *  4. Reference depth enforcement
 */

// ── Thresholds (ms) ─────────────────────────────────────
const THRESHOLDS = {
  FIELD_RESOLUTION_WARN: 200, // single resolve > 200ms
  BULK_RESOLUTION_WARN: 500, // bulk resolve > 500ms
  VALIDATION_WARN: 150, // validation > 150ms
  SEARCH_INDEX_WARN: 100, // index build > 100ms
  FILTER_BUILD_WARN: 50, // filter build > 50ms
};

/** Max filter conditions allowed on searchIndex fields */
const MAX_FILTER_CONDITIONS = 10;

/** Max reference resolution depth — hardcoded to 1 */
const MAX_REFERENCE_DEPTH = 1;

// ═══════════════════════════════════════════════════════════
// TIMER
// ═══════════════════════════════════════════════════════════

/**
 * Start a performance timer.
 * @param {string} operation - Name of the operation being measured
 * @param {Object} [meta]   - Extra metadata for the log entry
 * @returns {{ end: () => number }} — call .end() to log and return elapsed ms
 */
export function startTimer(operation, meta = {}) {
  const start = process.hrtime.bigint();

  return {
    /**
     * Stop the timer, log if above threshold, return elapsed ms.
     * @param {string} [thresholdKey] - Key from THRESHOLDS to check against
     * @returns {number} elapsed milliseconds
     */
    end(thresholdKey = null) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      const roundedMs = Math.round(elapsed * 100) / 100;

      const threshold = thresholdKey ? THRESHOLDS[thresholdKey] : null;

      if (threshold && roundedMs > threshold) {
        logger.warn(`Slow operation: ${operation}`, {
          operation,
          durationMs: roundedMs,
          threshold,
          ...meta,
        });
      } else {
        logger.debug(`Perf: ${operation}`, {
          operation,
          durationMs: roundedMs,
          ...meta,
        });
      }

      return roundedMs;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// SAFE CUSTOM FILTER BUILDER
// ═══════════════════════════════════════════════════════════

/**
 * Build a Mongo filter object from user-supplied custom field filter params.
 * Only allows filtering on fields marked `isIndexed: true` in definition.
 *
 * Safeguards:
 *  - Rejects filters on non-indexed fields (returns error)
 *  - Limits max filter conditions to MAX_FILTER_CONDITIONS
 *  - Only operates on `searchIndex.*` paths (never raw `customData.*`)
 *  - Sanitizes values to prevent injection
 *
 * @param {Array}  fieldDefinitions - CustomField docs for the module
 * @param {Object} filterParams     - Client-supplied filters: { cf_company: "acme", cf_revenue_gte: 1000 }
 * @returns {{ filter: Object, errors: string[] }}
 *   filter — Mongo filter fragment to merge into the main query
 *   errors — Validation issues (non-empty = reject the request)
 *
 * Supported operators (via suffix):
 *   cf_name        → exact match (string) or $regex (if ends with *)
 *   cf_name_gte    → $gte
 *   cf_name_lte    → $lte
 *   cf_name_gt     → $gt
 *   cf_name_lt     → $lt
 *   cf_name_ne     → $ne
 *   cf_name_in     → $in (comma-separated)
 *   cf_name_exists → $exists
 */
export function buildSafeCustomFilter(fieldDefinitions, filterParams) {
  const errors = [];
  const filter = {};

  if (!filterParams || typeof filterParams !== "object") {
    return { filter, errors };
  }

  // Build a lookup of indexed field apiNames
  const indexedFields = new Map();
  for (const f of fieldDefinitions) {
    if (f.isIndexed) {
      indexedFields.set(f.apiName, f);
    }
  }

  // Extract only cf_* keys from filterParams
  const cfEntries = Object.entries(filterParams).filter(([key]) =>
    key.startsWith("cf_"),
  );

  if (cfEntries.length > MAX_FILTER_CONDITIONS) {
    errors.push(
      `Too many custom field filters: ${cfEntries.length} (max ${MAX_FILTER_CONDITIONS})`,
    );
    return { filter, errors };
  }

  // Supported operator suffixes
  const OPERATORS = ["_gte", "_lte", "_gt", "_lt", "_ne", "_in", "_exists"];

  for (const [rawKey, rawValue] of cfEntries) {
    // Parse operator suffix
    let apiName = rawKey;
    let operator = null;

    for (const op of OPERATORS) {
      if (rawKey.endsWith(op)) {
        apiName = rawKey.slice(0, -op.length);
        operator = op.slice(1); // remove leading _
        break;
      }
    }

    // Check if field is indexed
    if (!indexedFields.has(apiName)) {
      errors.push(
        `Cannot filter on "${apiName}": field is not indexed. Mark it as indexed in Custom Fields settings.`,
      );
      continue;
    }

    const fieldDef = indexedFields.get(apiName);
    const path = `searchIndex.${apiName}`;

    // Build the condition
    if (operator === "in") {
      const values = String(rawValue)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      filter[path] = { $in: values };
    } else if (operator === "exists") {
      filter[path] = { $exists: rawValue === "true" || rawValue === true };
    } else if (operator === "gte") {
      filter[path] = {
        ...(filter[path] || {}),
        $gte: castFilterValue(fieldDef, rawValue),
      };
    } else if (operator === "lte") {
      filter[path] = {
        ...(filter[path] || {}),
        $lte: castFilterValue(fieldDef, rawValue),
      };
    } else if (operator === "gt") {
      filter[path] = {
        ...(filter[path] || {}),
        $gt: castFilterValue(fieldDef, rawValue),
      };
    } else if (operator === "lt") {
      filter[path] = {
        ...(filter[path] || {}),
        $lt: castFilterValue(fieldDef, rawValue),
      };
    } else if (operator === "ne") {
      filter[path] = { $ne: castFilterValue(fieldDef, rawValue) };
    } else {
      // Default: exact match or prefix regex
      const val = castFilterValue(fieldDef, rawValue);
      if (typeof val === "string" && val.endsWith("*")) {
        // Prefix search — safe because we control the field path
        const escaped = val.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter[path] = { $regex: `^${escaped}`, $options: "i" };
      } else {
        filter[path] = val;
      }
    }
  }

  return { filter, errors };
}

/**
 * Cast a raw filter value to the appropriate type based on field definition.
 */
function castFilterValue(fieldDef, value) {
  switch (fieldDef.fieldType) {
    case "number":
    case "currency":
    case "percent": {
      const num = Number(value);
      return isNaN(num) ? value : num;
    }
    case "boolean":
      return value === "true" || value === true;
    case "date":
    case "datetime": {
      const d = new Date(value);
      return isNaN(d.getTime()) ? value : d;
    }
    default:
      return String(value);
  }
}

// ═══════════════════════════════════════════════════════════
// REFERENCE DEPTH GUARD
// ═══════════════════════════════════════════════════════════

/**
 * Verify resolution depth is within allowed limit.
 * In Phase 1, depth is always 1 (no recursive joins).
 *
 * @param {number} requestedDepth
 * @returns {{ allowed: boolean, maxDepth: number }}
 */
export function checkReferenceDepth(requestedDepth = 1) {
  return {
    allowed: requestedDepth <= MAX_REFERENCE_DEPTH,
    maxDepth: MAX_REFERENCE_DEPTH,
  };
}

export { THRESHOLDS, MAX_FILTER_CONDITIONS, MAX_REFERENCE_DEPTH };
