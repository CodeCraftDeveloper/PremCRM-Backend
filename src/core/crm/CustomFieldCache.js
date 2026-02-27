import logger from "../../utils/logger.js";

/**
 * CustomFieldCache — Lightweight in-memory cache for CustomField definitions.
 *
 * Purpose: Remove redundant DB reads during request-lifecycle operations.
 * In Phase 1, processCustomData triggers validateCustomData + buildSearchIndex,
 * each of which calls getByModule() separately. This cache ensures we hit DB
 * once and serve subsequent reads from memory for the same tenant+module combo.
 *
 * Design:
 *  - One Map entry per "tenantId:moduleApiName" key
 *  - TTL-based expiry (default 60s) — protects against stale data
 *  - Explicit invalidation on create/update/delete
 *  - Bounded size (MAX_ENTRIES) — prevents unbounded memory growth
 *  - Falls back to DB on miss — zero-risk degradation
 */

const DEFAULT_TTL_MS = 60_000; // 60 seconds
const MAX_ENTRIES = 500; // ~500 tenant-module combos max

class CustomFieldCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
    /** @type {Map<string, { fields: Array, timestamp: number }>} */
    this._store = new Map();
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._hits = 0;
    this._misses = 0;
  }

  /** Build composite key */
  _key(tenantId, moduleApiName) {
    return `${String(tenantId)}:${moduleApiName}`;
  }

  /**
   * Get cached fields for a tenant+module.
   * @returns {Array|null} — null on miss or expired entry
   */
  get(tenantId, moduleApiName) {
    const key = this._key(tenantId, moduleApiName);
    const entry = this._store.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._store.delete(key);
      this._misses++;
      return null;
    }

    this._hits++;
    return entry.fields;
  }

  /**
   * Store fields in cache.
   */
  set(tenantId, moduleApiName, fields) {
    const key = this._key(tenantId, moduleApiName);

    // Evict oldest entries if at capacity
    if (this._store.size >= this._maxEntries && !this._store.has(key)) {
      const firstKey = this._store.keys().next().value;
      this._store.delete(firstKey);
    }

    this._store.set(key, {
      fields,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate cache for a specific tenant+module.
   * Called on field create/update/delete.
   */
  invalidate(tenantId, moduleApiName) {
    const key = this._key(tenantId, moduleApiName);
    const deleted = this._store.delete(key);
    if (deleted) {
      logger.debug("CustomFieldCache invalidated", {
        tenantId: String(tenantId),
        moduleApiName,
      });
    }
  }

  /**
   * Invalidate ALL entries for a tenant (e.g. tenant settings change).
   */
  invalidateTenant(tenantId) {
    const prefix = `${String(tenantId)}:`;
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this._store.delete(key);
        count++;
      }
    }
    if (count > 0) {
      logger.debug("CustomFieldCache tenant invalidated", {
        tenantId: String(tenantId),
        entriesCleared: count,
      });
    }
  }

  /**
   * Clear entire cache (e.g. for tests or graceful shutdown).
   */
  clear() {
    this._store.clear();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Get cache statistics for monitoring.
   */
  stats() {
    return {
      size: this._store.size,
      maxEntries: this._maxEntries,
      ttlMs: this._ttlMs,
      hits: this._hits,
      misses: this._misses,
      hitRate:
        this._hits + this._misses > 0
          ? ((this._hits / (this._hits + this._misses)) * 100).toFixed(1) + "%"
          : "N/A",
    };
  }
}

/** Singleton instance — shared across the service layer */
const customFieldCache = new CustomFieldCache();

export default customFieldCache;
export { CustomFieldCache };
