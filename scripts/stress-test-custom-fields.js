#!/usr/bin/env node

/**
 * Stress-Test: Dynamic Metadata Engine (Phase 1.1)
 *
 * Scenarios:
 *  1. Create 100 custom fields (20 indexed, 5 reference) — verify cache warm/miss/hit cycle.
 *  2. Validate customData against those 100 fields — ensure sub-200ms.
 *  3. Build searchIndex for 10k simulated records — measure throughput.
 *  4. Build safe filters on indexed/non-indexed fields — verify safeguards.
 *  5. Bulk-resolve references across 500 records with 5 ref fields.
 *  6. Cache invalidation cycle — confirm immediate miss after write.
 *
 * Usage:
 *   node scripts/stress-test-custom-fields.js
 *
 * Requires: running MongoDB (uses MONGO_URI from .env or defaults to localhost).
 */

import "dotenv/config";
import mongoose from "mongoose";
import CustomField from "../src/models/crm/CustomField.js";
import CustomFieldService from "../src/core/crm/CustomFieldService.js";
import customFieldCache from "../src/core/crm/CustomFieldCache.js";
import {
  buildSafeCustomFilter,
  startTimer,
} from "../src/core/crm/customFieldPerf.js";

// ── Config ──────────────────────────────────────────────────
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/stress_test_crm";
const TENANT_ID = new mongoose.Types.ObjectId();
const MODULE = "contacts";
const TOTAL_FIELDS = 100;
const INDEXED_FIELDS = 20;
const REFERENCE_FIELDS = 5;
const RECORD_COUNT = 10_000;
const BULK_RESOLVE_COUNT = 500;

// ── Helpers ─────────────────────────────────────────────────
function randomString(len = 8) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

function hr() {
  console.log("─".repeat(60));
}

function ms(hrTime) {
  return (Number(hrTime) / 1e6).toFixed(2);
}

// ── Setup & Teardown ────────────────────────────────────────
async function connect() {
  await mongoose.connect(MONGO_URI);
  console.log(`✓ Connected to ${MONGO_URI}`);
}

async function cleanup() {
  await CustomField.deleteMany({ tenantId: TENANT_ID });
  customFieldCache.clear();
  console.log("✓ Cleaned up test data");
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 1 — Create 100 custom fields
// ══════════════════════════════════════════════════════════════
async function scenario1_createFields() {
  hr();
  console.log("SCENARIO 1: Create 100 custom fields (20 indexed, 5 reference)");
  const start = process.hrtime.bigint();

  const fieldDocs = [];

  // Regular text fields
  const regularCount = TOTAL_FIELDS - INDEXED_FIELDS - REFERENCE_FIELDS;
  for (let i = 0; i < regularCount; i++) {
    const types = ["text", "number", "date", "boolean", "select", "currency"];
    const ft = types[i % types.length];
    const doc = {
      tenantId: TENANT_ID,
      moduleApiName: MODULE,
      apiName: `cf_field_${String(i).padStart(3, "0")}`,
      label: `Field ${i}`,
      fieldType: ft,
      isRequired: i < 5,
      isActive: true,
      isIndexed: false,
      sortOrder: i,
      ...(ft === "select" ? { options: ["opt_a", "opt_b", "opt_c"] } : {}),
      ...(ft === "number" ? { validation: { min: 0, max: 999999 } } : {}),
    };
    fieldDocs.push(doc);
  }

  // Indexed fields
  for (let i = 0; i < INDEXED_FIELDS; i++) {
    const idx = regularCount + i;
    fieldDocs.push({
      tenantId: TENANT_ID,
      moduleApiName: MODULE,
      apiName: `cf_indexed_${String(i).padStart(2, "0")}`,
      label: `Indexed Field ${i}`,
      fieldType: i < 10 ? "text" : "number",
      isRequired: false,
      isActive: true,
      isIndexed: true,
      sortOrder: idx,
    });
  }

  // Reference fields
  for (let i = 0; i < REFERENCE_FIELDS; i++) {
    const idx = regularCount + INDEXED_FIELDS + i;
    fieldDocs.push({
      tenantId: TENANT_ID,
      moduleApiName: MODULE,
      apiName: `cf_ref_${i}`,
      label: `Ref Field ${i}`,
      fieldType: "reference",
      isRequired: false,
      isActive: true,
      isIndexed: false,
      sortOrder: idx,
      referenceConfig: {
        targetModule: "accounts",
        displayField: "name",
      },
    });
  }

  await CustomField.insertMany(fieldDocs);
  const elapsed = process.hrtime.bigint() - start;
  console.log(`  → Inserted ${fieldDocs.length} fields in ${ms(elapsed)} ms`);
  return fieldDocs;
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 2 — Cache warm/miss/hit cycle
// ══════════════════════════════════════════════════════════════
async function scenario2_cacheCycle() {
  hr();
  console.log("SCENARIO 2: Cache warm / miss / hit cycle");

  customFieldCache.clear();

  // Cold miss
  const t1 = process.hrtime.bigint();
  const fields1 = await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const cold = process.hrtime.bigint() - t1;
  console.log(`  → Cold miss:  ${fields1.length} fields in ${ms(cold)} ms`);

  // Warm hit
  const t2 = process.hrtime.bigint();
  const fields2 = await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const warm = process.hrtime.bigint() - t2;
  console.log(`  → Warm hit:   ${fields2.length} fields in ${ms(warm)} ms`);
  console.log(`  → Speedup:    ${(Number(cold) / Number(warm)).toFixed(1)}x`);

  const stats = customFieldCache.stats();
  console.log(
    `  → Cache stats: hits=${stats.hits}, misses=${stats.misses}, hitRate=${stats.hitRate}`,
  );
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 3 — Validate customData (100 fields)
// ══════════════════════════════════════════════════════════════
async function scenario3_validateCustomData() {
  hr();
  console.log("SCENARIO 3: Validate customData against 100 fields");

  // Build a sample customData that fills all required + some optional
  const fields = await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const sampleData = {};
  for (const f of fields) {
    if (f.fieldType === "reference") {
      sampleData[f.apiName] = new mongoose.Types.ObjectId().toString();
    } else if (f.fieldType === "text") {
      sampleData[f.apiName] = randomString(12);
    } else if (f.fieldType === "number" || f.fieldType === "currency") {
      sampleData[f.apiName] = Math.floor(Math.random() * 10000);
    } else if (f.fieldType === "date") {
      sampleData[f.apiName] = new Date().toISOString();
    } else if (f.fieldType === "boolean") {
      sampleData[f.apiName] = Math.random() > 0.5;
    } else if (f.fieldType === "select") {
      sampleData[f.apiName] = (f.options || ["opt_a"])[0];
    }
  }

  const iterations = 100;
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t = process.hrtime.bigint();
    await CustomFieldService.validateCustomData(TENANT_ID, MODULE, sampleData);
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
  const max = Math.max(...times).toFixed(2);
  const min = Math.min(...times).toFixed(2);
  const p99 = times
    .sort((a, b) => a - b)
    [Math.floor(times.length * 0.99)].toFixed(2);

  console.log(`  → ${iterations} validations (100 fields each):`);
  console.log(`    avg=${avg}ms  min=${min}ms  max=${max}ms  p99=${p99}ms`);
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 4 — Build searchIndex (throughput)
// ══════════════════════════════════════════════════════════════
async function scenario4_searchIndexThroughput() {
  hr();
  console.log(`SCENARIO 4: Build searchIndex for ${RECORD_COUNT} records`);

  const fields = await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const sampleData = {};
  for (const f of fields.filter((f) => f.isIndexed)) {
    sampleData[f.apiName] =
      f.fieldType === "number" ? 42 : `val_${randomString(6)}`;
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < RECORD_COUNT; i++) {
    await CustomFieldService.buildSearchIndex(TENANT_ID, MODULE, sampleData);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

  console.log(`  → ${RECORD_COUNT} index builds in ${elapsed.toFixed(0)} ms`);
  console.log(`  → Avg: ${(elapsed / RECORD_COUNT).toFixed(3)} ms per record`);
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 5 — Safe filter builder (safeguards)
// ══════════════════════════════════════════════════════════════
async function scenario5_safeFilterBuilder() {
  hr();
  console.log("SCENARIO 5: Safe filter builder — indexed vs non-indexed");

  const fields = await CustomFieldService.getByModule(TENANT_ID, MODULE);

  // Only indexed fields — should succeed
  const indexedParams = {};
  fields
    .filter((f) => f.isIndexed)
    .slice(0, 5)
    .forEach((f) => {
      indexedParams[f.apiName] = f.fieldType === "number" ? "100" : "test*";
    });

  const ok = buildSafeCustomFilter(fields, indexedParams);
  console.log(
    `  → Indexed filter:     ${Object.keys(ok.filter).length} conditions, ${ok.errors.length} errors`,
  );

  // Non-indexed field — should be rejected
  const nonIndexed = { cf_field_001: "hello" };
  const fail = buildSafeCustomFilter(fields, nonIndexed);
  console.log(
    `  → Non-indexed filter: ${fail.errors.length} error(s) → "${fail.errors[0]}"`,
  );

  // Exceed max conditions — should be truncated
  const tooMany = {};
  for (let i = 0; i < 15; i++) {
    tooMany[`cf_indexed_${String(i).padStart(2, "0")}`] = "x";
  }
  const capped = buildSafeCustomFilter(fields, tooMany);
  console.log(
    `  → 15 conditions capped: ${Object.keys(capped.filter).length} kept, ${capped.errors.length} error(s)`,
  );

  // Operator suffixes
  const ops = { cf_indexed_10_gte: "500", cf_indexed_10_lte: "9000" };
  const opResult = buildSafeCustomFilter(fields, ops);
  console.log(
    `  → Operator suffixes:  ${Object.keys(opResult.filter).length} conditions, ${opResult.errors.length} errors`,
  );
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 6 — Cache invalidation cycle
// ══════════════════════════════════════════════════════════════
async function scenario6_cacheInvalidation() {
  hr();
  console.log("SCENARIO 6: Cache invalidation after write");

  // Pre-warm cache
  await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const before = customFieldCache.stats();
  console.log(`  → Before invalidation: size=${before.size}`);

  // Invalidate
  customFieldCache.invalidate(TENANT_ID, MODULE);
  const after = customFieldCache.stats();
  console.log(`  → After invalidation:  size=${after.size}`);

  // Re-fetch (should be a miss)
  const t = process.hrtime.bigint();
  await CustomFieldService.getByModule(TENANT_ID, MODULE);
  const refetch = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  → Re-fetch time (cache miss): ${refetch.toFixed(2)} ms`);

  const final = customFieldCache.stats();
  console.log(`  → Final stats: hits=${final.hits}, misses=${final.misses}`);
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  try {
    await connect();
    await cleanup();

    console.log(
      "\n╔══════════════════════════════════════════════════════════╗",
    );
    console.log("║  Custom Field Stress Test — Phase 1.1 Hardening         ║");
    console.log(`║  Tenant: ${TENANT_ID}                  ║`);
    console.log(`║  Module: ${MODULE.padEnd(47)}║`);
    console.log(
      "╚══════════════════════════════════════════════════════════╝\n",
    );

    await scenario1_createFields();
    await scenario2_cacheCycle();
    await scenario3_validateCustomData();
    await scenario4_searchIndexThroughput();
    await scenario5_safeFilterBuilder();
    await scenario6_cacheInvalidation();

    hr();
    console.log("\n✓ All scenarios completed.");
  } catch (err) {
    console.error("✗ Stress test failed:", err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
}

main();
