/**
 * Tests for the P1-003 Usage Metering Foundation:
 *  1. UsageMeter model upsert behaviour for $inc and $max
 *  2. usageMeterService increment / setStorageBytes / summary shape
 *  3. GET /api/v1/tenants/:id/usage endpoint contract and tenant scoping
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
let UsageMeter;
let usageMeterService;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function createTenantCtx(slug, plan = "growth") {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan,
  });
  const user = await User.create({
    name: `Admin ${slug}`,
    email: `admin@${slug}.com`,
    password: "Password123!",
    role: "admin",
    tenantId: tenant._id,
    isActive: true,
    approvalStatus: "approved",
  });
  const token = makeToken(user._id, tenant._id, "admin");
  return { tenant, user, token };
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
  UsageMeter = (await import("../../src/models/UsageMeter.js")).default;
  usageMeterService = await import("../../src/services/usageMeterService.js");
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("UsageMeter model", () => {
  it("upserts a single document per tenant per period and increments counters", async () => {
    const ctx = await createTenantCtx("usage-model-inc");

    await usageMeterService.incrementUsage(
      ctx.tenant._id,
      "workflowRuns",
      3,
    );
    await usageMeterService.incrementUsage(ctx.tenant._id, "workflowRuns", 2);
    await usageMeterService.incrementUsage(ctx.tenant._id, "aiRuns", 5);

    const period = usageMeterService.getPeriodForDate();
    const docs = await UsageMeter.find({ tenantId: ctx.tenant._id });
    expect(docs).toHaveLength(1);
    expect(docs[0].period).toBe(period);
    expect(docs[0].workflowRuns).toBe(5);
    expect(docs[0].aiRuns).toBe(5);
  });

  it("rejects unknown counter keys", async () => {
    const ctx = await createTenantCtx("usage-model-bad-key");
    await expect(
      usageMeterService.incrementUsage(ctx.tenant._id, "notARealCounter", 1),
    ).rejects.toThrow(/Unknown counter key/);
  });

  it("uses $max semantics for storageBytes (high-water mark)", async () => {
    const ctx = await createTenantCtx("usage-model-storage");

    await usageMeterService.setStorageBytes(ctx.tenant._id, 1000);
    await usageMeterService.setStorageBytes(ctx.tenant._id, 500); // smaller, ignored
    await usageMeterService.setStorageBytes(ctx.tenant._id, 2500); // larger, applied

    const doc = await UsageMeter.findOne({ tenantId: ctx.tenant._id });
    expect(doc.storageBytes).toBe(2500);
  });

  it("isolates counters across tenants", async () => {
    const a = await createTenantCtx("usage-iso-a");
    const b = await createTenantCtx("usage-iso-b");

    await usageMeterService.incrementUsage(a.tenant._id, "messagesSent", 10);
    await usageMeterService.incrementUsage(b.tenant._id, "messagesSent", 1);

    const aPeriod = await usageMeterService.getCurrentPeriod(a.tenant._id);
    const bPeriod = await usageMeterService.getCurrentPeriod(b.tenant._id);
    expect(aPeriod.messagesSent).toBe(10);
    expect(bPeriod.messagesSent).toBe(1);
  });
});

describe("getTenantUsageSummary", () => {
  it("returns plan limits, live seat count, and headroom for a growth tenant", async () => {
    const ctx = await createTenantCtx("usage-summary-growth", "growth");

    // Two more active users + one inactive (should not count)
    await User.create({
      name: "Marketer",
      email: "marketer@usage-summary-growth.com",
      password: "Password123!",
      role: "marketing",
      tenantId: ctx.tenant._id,
      isActive: true,
      approvalStatus: "approved",
    });
    await User.create({
      name: "User",
      email: "user@usage-summary-growth.com",
      password: "Password123!",
      role: "user",
      tenantId: ctx.tenant._id,
      isActive: true,
      approvalStatus: "approved",
    });
    await User.create({
      name: "Disabled",
      email: "off@usage-summary-growth.com",
      password: "Password123!",
      role: "user",
      tenantId: ctx.tenant._id,
      isActive: false,
      approvalStatus: "approved",
    });

    await usageMeterService.incrementUsage(
      ctx.tenant._id,
      "workflowRuns",
      250,
    );
    await usageMeterService.setStorageBytes(ctx.tenant._id, 1024);

    const summary = await usageMeterService.getTenantUsageSummary(
      ctx.tenant._id,
    );

    expect(summary.tenant.planCanonical).toBe("growth");
    // growth: maxUsers = 15, maxWorkflowRunsPerMonth = 1000
    expect(summary.usage.seats).toBe(3); // admin + marketer + user
    expect(summary.headroom.seats).toEqual({
      used: 3,
      limit: 15,
      remaining: 12,
      percent: 20,
      exceeded: false,
      unlimited: false,
    });

    expect(summary.usage.workflowRuns).toBe(250);
    expect(summary.headroom.workflowRuns.percent).toBe(25);
    expect(summary.headroom.workflowRuns.remaining).toBe(750);
    expect(summary.headroom.workflowRuns.exceeded).toBe(false);

    expect(summary.usage.storageBytes).toBe(1024);
    expect(summary.headroom.storageBytes.unlimited).toBe(false);
  });

  it("reports unlimited headroom for enterprise plans", async () => {
    const ctx = await createTenantCtx("usage-summary-ent", "enterprise");

    const summary = await usageMeterService.getTenantUsageSummary(
      ctx.tenant._id,
    );

    expect(summary.tenant.planCanonical).toBe("enterprise");
    expect(summary.headroom.seats.unlimited).toBe(true);
    expect(summary.headroom.workflowRuns.unlimited).toBe(true);
    expect(summary.headroom.storageBytes.unlimited).toBe(true);
  });

  it("returns null for an unknown tenant", async () => {
    const ghostId = new mongoose.Types.ObjectId();
    const summary = await usageMeterService.getTenantUsageSummary(ghostId);
    expect(summary).toBeNull();
  });
});

describe("GET /api/v1/tenants/:id/usage", () => {
  it("returns 200 with usage summary for the caller's own tenant", async () => {
    const ctx = await createTenantCtx("usage-endpoint-self", "growth");

    await usageMeterService.incrementUsage(ctx.tenant._id, "aiRuns", 12);

    const res = await request
      .get(`/api/v1/tenants/${ctx.tenant._id}/usage`)
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tenant.id).toBe(ctx.tenant._id.toString());
    expect(res.body.data.tenant.planCanonical).toBe("growth");
    expect(res.body.data.usage.aiRuns).toBe(12);
    expect(res.body.data.headroom.aiRuns.used).toBe(12);
    // growth: maxAiRunsPerMonth = 500
    expect(res.body.data.headroom.aiRuns.limit).toBe(500);
  });

  it("forbids cross-tenant reads for non-superadmins", async () => {
    const a = await createTenantCtx("usage-endpoint-a", "growth");
    const b = await createTenantCtx("usage-endpoint-b", "growth");

    const res = await request
      .get(`/api/v1/tenants/${b.tenant._id}/usage`)
      .set("Authorization", `Bearer ${a.token}`);

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const ctx = await createTenantCtx("usage-endpoint-anon", "growth");

    const res = await request.get(`/api/v1/tenants/${ctx.tenant._id}/usage`);
    expect(res.status).toBe(401);
  });

  it("validates the tenant id is a valid Mongo ObjectId", async () => {
    const ctx = await createTenantCtx("usage-endpoint-bad-id", "growth");

    const res = await request
      .get(`/api/v1/tenants/not-an-objectid/usage`)
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(400);
  });
});
