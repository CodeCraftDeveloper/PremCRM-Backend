/**
 * Shared test setup: MongoMemoryServer + Express app bootstrap
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

let mongoServer;

/**
 * Start an in-memory MongoDB and connect mongoose.
 */
export async function setupTestDB() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
}

/**
 * Drop all collections and disconnect.
 */
export async function teardownTestDB() {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key of Object.keys(collections)) {
      await collections[key].deleteMany({});
    }
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}

/**
 * Clear all collections without disconnecting.
 */
export async function clearTestDB() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

/**
 * Generate a valid JWT access token for testing.
 */
export function generateTestToken(userId, tenantId, role = "admin") {
  const secret = process.env.JWT_ACCESS_SECRET || "test-access-secret-key";
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    secret,
    { expiresIn: "1h" },
  );
}

/**
 * Create tenant, user, and return auth token.
 */
export async function createTestTenant(overrides = {}) {
  const Tenant =
    mongoose.models.Tenant ||
    (await import("../../src/models/Tenant.js")).default;
  const User =
    mongoose.models.User || (await import("../../src/models/User.js")).default;

  const tenant = await Tenant.create({
    name: overrides.tenantName || "Test Tenant",
    slug: overrides.slug || `test-${Date.now()}`,
    isActive: true,
    plan: "pro",
    ...overrides.tenantData,
  });

  const user = await User.create({
    name: overrides.userName || "Test Admin",
    email: overrides.email || `admin-${Date.now()}@test.com`,
    password: overrides.password || "hashedPassword123!",
    role: overrides.role || "admin",
    tenantId: tenant._id,
    isActive: true,
    isApproved: true,
    ...overrides.userData,
  });

  const token = generateTestToken(user._id, tenant._id, user.role);

  return { tenant, user, token };
}
