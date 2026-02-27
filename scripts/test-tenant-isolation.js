/**
 * Cross-Tenant Isolation Smoke Test
 * ==================================
 * Validates that service-layer methods enforce tenantId scoping.
 *
 * Usage:
 *   node --experimental-vm-modules scripts/test-tenant-isolation.js
 *
 * Prerequisites:
 *   - MongoDB running (uses MONGO_URI from .env or defaults to localhost)
 *   - Redis running (graceful degradation if absent)
 *
 * This script:
 *   1. Creates two isolated test tenants (A & B)
 *   2. Creates a user + lead in each
 *   3. Attempts cross-tenant operations via service methods
 *   4. Asserts every cross-tenant read/write returns null or throws
 *   5. Cleans up all test data
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, "../.env") });

// ── Models ──────────────────────────────────────────────────────────────
import Tenant from "../src/models/Tenant.js";
import User from "../src/models/User.js";
import Lead from "../src/models/Lead.js";
import Website from "../src/models/Website.js";
import UserSession from "../src/models/UserSession.js";
import LeadActivity from "../src/models/LeadActivity.js";

// ── Services under test ─────────────────────────────────────────────────
import SessionService from "../src/core/auth/SessionService.js";
import AssignmentService from "../src/core/leads/AssignmentService.js";
import DuplicateDetectionService from "../src/core/leads/DuplicateDetectionService.js";
import LeadService from "../src/core/leads/LeadService.js";
import UserService from "../src/modules/users/services/UserService.js";

// ── Test helpers ────────────────────────────────────────────────────────
const TEST_PREFIX = "__isolation_test__";
let tenantA, tenantB, userA, userB, leadA, leadB, sessionA;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ FAIL: ${label}`);
  }
}

async function assertThrows(fn, label) {
  try {
    await fn();
    failed++;
    failures.push(label);
    console.log(`  ❌ FAIL (no throw): ${label}`);
  } catch {
    passed++;
    console.log(`  ✅ ${label}`);
  }
}

// ── Setup ───────────────────────────────────────────────────────────────
async function setup() {
  console.log("\n🔧  Setting up test fixtures...\n");

  // Create two tenants
  tenantA = await Tenant.create({
    name: `${TEST_PREFIX}_TenantA`,
    slug: `${TEST_PREFIX}-a`,
    isActive: true,
    owner: new mongoose.Types.ObjectId(),
  });

  tenantB = await Tenant.create({
    name: `${TEST_PREFIX}_TenantB`,
    slug: `${TEST_PREFIX}-b`,
    isActive: true,
    owner: new mongoose.Types.ObjectId(),
  });

  // Create users
  userA = await User.create({
    tenantId: tenantA._id,
    name: "User A",
    email: `${TEST_PREFIX}-a@test.local`,
    password: "TestPassword123!",
    role: "admin",
    isActive: true,
  });

  userB = await User.create({
    tenantId: tenantB._id,
    name: "User B",
    email: `${TEST_PREFIX}-b@test.local`,
    password: "TestPassword123!",
    role: "admin",
    isActive: true,
  });

  // Create a website for tenant A (needed for lead creation)
  const websiteA = await Website.create({
    tenantId: tenantA._id,
    name: `${TEST_PREFIX}_WebA`,
    domain: `${TEST_PREFIX}-a.test`,
    category: "contact_form",
    apiKey: `${TEST_PREFIX}_key_a`,
    duplicateSettings: { checkEmail: true, checkPhone: true },
  });

  // Create leads
  leadA = await Lead.create({
    tenantId: tenantA._id,
    websiteId: websiteA._id,
    fullName: "Lead A",
    firstName: "Lead",
    lastName: "A",
    email: `${TEST_PREFIX}-lead-a@test.local`,
    phone: "1111111111",
    status: "new",
    source: "contact_form",
  });

  leadB = await Lead.create({
    tenantId: tenantB._id,
    websiteId: websiteA._id, // mis-assignment doesn't matter for isolation test
    fullName: "Lead B",
    firstName: "Lead",
    lastName: "B",
    email: `${TEST_PREFIX}-lead-b@test.local`,
    phone: "2222222222",
    status: "new",
    source: "contact_form",
  });

  // Create a session for user A
  sessionA = await UserSession.create({
    user: userA._id,
    tenantId: tenantA._id,
    loginTime: new Date(),
    isActive: true,
    ipAddress: "127.0.0.1",
    userAgent: "IsolationTest/1.0",
  });

  console.log("  Tenant A:", tenantA._id.toString());
  console.log("  Tenant B:", tenantB._id.toString());
  console.log("  User A:", userA._id.toString());
  console.log("  User B:", userB._id.toString());
  console.log("  Lead A:", leadA._id.toString());
  console.log("  Lead B:", leadB._id.toString());
  console.log("  Session A:", sessionA._id.toString());
}

// ── Tests ───────────────────────────────────────────────────────────────

async function testSessionService() {
  console.log("\n── SessionService ──────────────────────────────────────\n");

  // endSession with wrong tenantId should return null or leave session unchanged
  const beforeEnd = await UserSession.findById(sessionA._id).lean();
  try {
    const result = await SessionService.endSession(sessionA._id, tenantB._id);
    // If it returns null, the tenantId filter worked
    assert(
      result === null || result === undefined,
      "endSession: wrong tenantId returns null",
    );
  } catch {
    // If it throws "Session not found", that's also correct
    assert(true, "endSession: wrong tenantId throws");
  }
  // Session should still be active
  const afterEnd = await UserSession.findById(sessionA._id).lean();
  assert(
    afterEnd.isActive === true,
    "endSession: session still active after wrong-tenant attempt",
  );

  // getUserActiveSessions with wrong tenantId should return empty
  const crossSessions = await SessionService.getUserActiveSessions(
    userA._id,
    tenantB._id,
  );
  assert(
    Array.isArray(crossSessions) && crossSessions.length === 0,
    "getUserActiveSessions: wrong tenantId returns empty",
  );

  // getUserActiveSessions with correct tenantId should find the session
  const correctSessions = await SessionService.getUserActiveSessions(
    userA._id,
    tenantA._id,
  );
  assert(
    correctSessions.length >= 1,
    "getUserActiveSessions: correct tenantId returns session(s)",
  );

  // getSessionMetrics with wrong tenantId should return zeros
  const crossMetrics = await SessionService.getSessionMetrics(
    userA._id,
    tenantB._id,
  );
  assert(
    crossMetrics.totalSessions === 0,
    "getSessionMetrics: wrong tenantId returns zero sessions",
  );

  // endSession with correct tenantId should work
  const ended = await SessionService.endSession(sessionA._id, tenantA._id);
  assert(
    ended && ended.isActive === false,
    "endSession: correct tenantId ends session",
  );
}

async function testAssignmentService() {
  console.log("\n── AssignmentService ───────────────────────────────────\n");

  // Re-activate lead A for this test
  await Lead.findByIdAndUpdate(leadA._id, {
    assignedTo: undefined,
    status: "new",
  });

  // assignLeadToUser with wrong tenantId — lead belongs to A, pass tenantId B
  try {
    const result = await AssignmentService.assignLeadToUser(
      leadA._id,
      userA._id,
      tenantB._id, // wrong tenant
      "manual",
    );
    // Should fail: lead not found under tenantB
    assert(false, "assignLeadToUser: wrong tenantId should not succeed");
  } catch (err) {
    assert(
      err.message.includes("not found"),
      "assignLeadToUser: wrong tenantId throws 'not found'",
    );
  }

  // assignLeadToUser with correct tenantId should work
  const result = await AssignmentService.assignLeadToUser(
    leadA._id,
    userA._id,
    tenantA._id,
    "manual",
  );
  assert(
    result && result.assignedTo.toString() === userA._id.toString(),
    "assignLeadToUser: correct tenantId succeeds",
  );
}

async function testDuplicateDetectionService() {
  console.log("\n── DuplicateDetectionService ───────────────────────────\n");

  // markAsDuplicate with wrong tenantId should return null
  const dupResult = await DuplicateDetectionService.markAsDuplicate(
    leadA._id,
    leadB._id,
    tenantB._id, // wrong tenant for leadA
  );
  assert(
    dupResult === null || dupResult === undefined,
    "markAsDuplicate: wrong tenantId returns null",
  );
  // Verify lead A is NOT marked as duplicate
  const checkA = await Lead.findById(leadA._id).lean();
  assert(
    checkA.isDuplicate !== true,
    "markAsDuplicate: lead NOT marked as duplicate with wrong tenant",
  );

  // mergeDuplicates with wrong tenantId should throw "not found"
  try {
    await DuplicateDetectionService.mergeDuplicates(
      leadA._id,
      leadB._id, // different tenant's lead
      tenantB._id, // wrong tenant
      userB._id,
    );
    assert(false, "mergeDuplicates: wrong tenantId should throw");
  } catch (err) {
    assert(
      err.message.includes("not found"),
      "mergeDuplicates: wrong tenantId throws 'not found'",
    );
  }
}

async function testLeadService() {
  console.log("\n── LeadService ────────────────────────────────────────\n");

  // updateLeadStatus with wrong tenantId should throw "not found"
  try {
    await LeadService.updateLeadStatus(
      leadA._id,
      "contacted",
      tenantB._id,
      userB._id,
    );
    assert(false, "updateLeadStatus: wrong tenantId should throw");
  } catch (err) {
    assert(
      err.message.includes("not found"),
      "updateLeadStatus: wrong tenantId throws 'not found'",
    );
  }

  // Verify lead A status unchanged
  const checkA = await Lead.findById(leadA._id).lean();
  assert(
    checkA.status !== "contacted",
    "updateLeadStatus: lead status unchanged after wrong-tenant attempt",
  );

  // updateLeadStatus with correct tenantId should work
  const updated = await LeadService.updateLeadStatus(
    leadA._id,
    "contacted",
    tenantA._id,
    userA._id,
  );
  assert(
    updated && updated.status === "contacted",
    "updateLeadStatus: correct tenantId succeeds",
  );
}

async function testUserService() {
  console.log("\n── UserService ────────────────────────────────────────\n");

  // createUser without tenantId should throw
  try {
    await UserService.createUser({
      name: "No Tenant User",
      email: `${TEST_PREFIX}-no-tenant@test.local`,
      password: "TestPassword123!",
      role: "user",
      // tenantId intentionally omitted
    });
    assert(false, "createUser: missing tenantId should throw");
  } catch {
    assert(true, "createUser: missing tenantId throws");
  }

  // updateUserProfile with wrong tenantId should return null
  const crossUpdate = await UserService.updateUserProfile(
    userA._id,
    tenantB._id,
    { name: "Hacked Name" },
  );
  assert(
    crossUpdate === null,
    "updateUserProfile: wrong tenantId returns null",
  );
  // Verify name unchanged
  const checkA = await User.findById(userA._id).lean();
  assert(
    checkA.name === "User A",
    "updateUserProfile: name unchanged after wrong-tenant attempt",
  );

  // setUserStatus with wrong tenantId should return null
  const crossStatus = await UserService.setUserStatus(
    userA._id,
    tenantB._id,
    false,
  );
  assert(crossStatus === null, "setUserStatus: wrong tenantId returns null");
  // Verify status unchanged
  const checkA2 = await User.findById(userA._id).lean();
  assert(
    checkA2.isActive === true,
    "setUserStatus: user still active after wrong-tenant attempt",
  );

  // changePassword with wrong tenantId should throw "not found"
  try {
    await UserService.changePassword(
      userA._id,
      tenantB._id,
      "TestPassword123!",
      "NewPass456!",
    );
    assert(false, "changePassword: wrong tenantId should throw");
  } catch (err) {
    assert(
      err.message.includes("not found"),
      "changePassword: wrong tenantId throws 'not found'",
    );
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup() {
  console.log("\n🧹  Cleaning up test data...");

  await LeadActivity.deleteMany({
    $or: [{ tenantId: tenantA?._id }, { tenantId: tenantB?._id }],
  });
  await UserSession.deleteMany({
    $or: [{ tenantId: tenantA?._id }, { tenantId: tenantB?._id }],
  });
  await Lead.deleteMany({
    $or: [{ tenantId: tenantA?._id }, { tenantId: tenantB?._id }],
  });
  await Website.deleteMany({ tenantId: tenantA?._id });
  await User.deleteMany({
    email: { $regex: `^${TEST_PREFIX}` },
  });
  await Tenant.deleteMany({
    slug: { $regex: `^${TEST_PREFIX}` },
  });

  console.log("  Done.\n");
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║        Cross-Tenant Isolation Smoke Tests                   ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );

  const mongoUri =
    process.env.MONGO_URI || "mongodb://localhost:27017/event-registration";

  try {
    await mongoose.connect(mongoUri);
    console.log(
      `\n📦  Connected to MongoDB: ${mongoUri.replace(/\/\/.*@/, "//***@")}`,
    );

    await setup();
    await testSessionService();
    await testAssignmentService();
    await testDuplicateDetectionService();
    await testLeadService();
    await testUserService();

    console.log(
      "\n══════════════════════════════════════════════════════════════",
    );
    console.log(`  Results:  ✅ ${passed} passed  ❌ ${failed} failed`);
    if (failures.length > 0) {
      console.log("\n  Failed tests:");
      failures.forEach((f) => console.log(`    • ${f}`));
    }
    console.log(
      "══════════════════════════════════════════════════════════════\n",
    );
  } catch (err) {
    console.error("\n💥  Fatal error:", err.message);
    console.error(err.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
