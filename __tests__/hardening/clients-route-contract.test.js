/**
 * P0-001 — canonical Clients API route contract.
 *
 * Asserts that:
 *   1. `GET /api/v1/clients` is mounted (never returns 404) and honours the
 *      existing `protect` middleware — 401 without a token, 200 with one.
 *   2. `GET /api/clients` compatibility mount still resolves the same handler.
 *
 * Does not exercise controller/service business logic — that is covered by
 * the controller-level tests.  The contract under test is purely the route
 * mounting agreement between the browser (`client/src/services/api.js`
 * defaults to `/api/v1`) and `app.js`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let app;
let request;

let Tenant;
let User;

function signToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const appModule = await import("../../app.js");
  app = appModule.default;

  const supertest = await import("supertest");
  request = supertest.default(app);

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("Clients route contract (P0-001)", () => {
  it("mounts GET /api/v1/clients — 401 without auth, never 404", async () => {
    const res = await request.get("/api/v1/clients");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it("returns 200 for an authenticated tenant admin at /api/v1/clients", async () => {
    const tenant = await Tenant.create({
      name: "Route Contract Tenant",
      slug: "route-contract",
      isActive: true,
      plan: "pro",
      subscription: { status: "active" },
    });
    const admin = await User.create({
      name: "Route Admin",
      email: "route-admin@example.com",
      password: "Password123!",
      role: "admin",
      tenantId: tenant._id,
      approvalStatus: "approved",
      isActive: true,
    });
    const token = signToken(admin._id, tenant._id, "admin");

    const res = await request
      .get("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
  });

  it("preserves /api/clients compatibility mount", async () => {
    const tenant = await Tenant.create({
      name: "Compat Tenant",
      slug: "route-contract-compat",
      isActive: true,
      plan: "pro",
      subscription: { status: "active" },
    });
    const admin = await User.create({
      name: "Compat Admin",
      email: "compat-admin@example.com",
      password: "Password123!",
      role: "admin",
      tenantId: tenant._id,
      approvalStatus: "approved",
      isActive: true,
    });
    const token = signToken(admin._id, tenant._id, "admin");

    const unauth = await request.get("/api/clients");
    expect(unauth.status).not.toBe(404);
    expect(unauth.status).toBe(401);

    const authed = await request
      .get("/api/clients")
      .set("Authorization", `Bearer ${token}`);
    expect(authed.status).toBe(200);
    expect(authed.body?.success).toBe(true);
  });
});
