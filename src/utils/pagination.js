/**
 * pagination.js — Phase 2 Hardening: Global Pagination Policy
 *
 * Enforces:
 *  - Default page size (DEFAULT_LIMIT)
 *  - Maximum page size cap (MAX_LIMIT) — rejects requests exceeding cap
 *  - Minimum page = 1
 *
 * Usage in service layer:
 *   const { page, limit, skip } = enforcePagination(opts);
 *
 * Usage in controller layer (for raw query params):
 *   const { page, limit, skip } = enforcePagination({
 *     page: parseInt(req.query.page),
 *     limit: parseInt(req.query.limit),
 *   });
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Enforce pagination boundaries.
 *
 * @param {Object}  opts
 * @param {number}  [opts.page=1]   — Requested page (clamped to >= 1)
 * @param {number}  [opts.limit]    — Requested limit (clamped to <= MAX_LIMIT)
 * @param {number}  [defaultLimit]  — Override default limit for this call
 * @param {boolean} [opts.strict=false] — If true, throw 400 when limit > MAX_LIMIT
 *                                         instead of silently clamping
 * @returns {{ page: number, limit: number, skip: number }}
 * @throws {Error}  When strict=true and limit exceeds MAX_LIMIT
 */
export function enforcePagination(
  { page, limit, strict = false } = {},
  defaultLimit = DEFAULT_LIMIT,
) {
  // Normalise page
  let safePage = parseInt(page, 10);
  if (!Number.isFinite(safePage) || safePage < 1) safePage = 1;

  // Normalise limit
  let safeLimit = parseInt(limit, 10);
  if (!Number.isFinite(safeLimit) || safeLimit < 1) {
    safeLimit = defaultLimit;
  }

  // Enforce ceiling
  if (safeLimit > MAX_LIMIT) {
    if (strict) {
      const err = new Error(
        `Limit ${safeLimit} exceeds maximum allowed (${MAX_LIMIT}). ` +
          `Please use pagination with limit ≤ ${MAX_LIMIT}.`,
      );
      err.statusCode = 400;
      throw err;
    }
    safeLimit = MAX_LIMIT;
  }

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
  };
}

export { DEFAULT_LIMIT, MAX_LIMIT };
