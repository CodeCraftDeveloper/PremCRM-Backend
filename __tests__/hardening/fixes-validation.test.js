/**
 * Validation tests for the hardening round-2 fixes.
 *
 * Covers:
 *  1. AuditLog entityType: "ticket" acceptance
 *  2. Remark model tenantId isolation (Remark, LeadRemark, TicketRemark)
 *  3. TicketRemark static helpers propagate tenantId
 *  4. Rate limiter configuration (bootstrap & global)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

// ── env must be set before any app imports ──
process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = ""; // disable redis in tests

let mongoServer;
let app;
let request;

// Models (loaded after mongoose.connect)
let AuditLog,
  Tenant,
  User,
  Ticket,
  TicketRemark,
  Lead,
  LeadRemark,
  Client,
  Remark;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// ── Global setup ──
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  const appModule = await import("../../app.js");
  app = appModule.default;

  const supertest = await import("supertest");
  request = supertest.default(app);

  AuditLog = (await import("../../src/models/AuditLog.js")).default;
  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  Ticket = (await import("../../src/models/Ticket.js")).default;
  TicketRemark = (await import("../../src/models/TicketRemark.js")).default;
  Lead = (await import("../../src/models/Lead.js")).default;
  LeadRemark = (await import("../../src/models/LeadRemark.js")).default;
  Client = (await import("../../src/models/Client.js")).default;
  Remark = (await import("../../src/models/Remark.js")).default;
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

// ── Helper: create a tenant + admin user + JWT ──
async function createTenantCtx(slug) {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "pro",
  });
  const user = await User.create({
    name: `Admin ${slug}`,
    email: `admin@${slug}.com`,
    password: "$2b$10$dummyHashedPasswordForTesting1234567890ab",
    role: "admin",
    tenantId: tenant._id,
    isActive: true,
    isApproved: true,
  });
  const token = makeToken(user._id, tenant._id, "admin");
  return { tenant, user, token };
}

// ────────────────────────────────────────────────
// 1. AuditLog accepts entityType "ticket"
// ────────────────────────────────────────────────
describe("AuditLog entityType 'ticket'", () => {
  it("should persist an audit record with entityType 'ticket'", async () => {
    const tenantCtx = await createTenantCtx("audit-ticket");
    const doc = await AuditLog.create({
      tenantId: tenantCtx.tenant._id,
      userId: tenantCtx.user._id,
      action: "ticket.create",
      entityType: "ticket",
      entityId: new mongoose.Types.ObjectId(),
      description: "Unit test — ticket entity type",
    });

    expect(doc).toBeDefined();
    expect(doc.entityType).toBe("ticket");
  });

  it("should reject an unknown entityType", async () => {
    const tenantCtx = await createTenantCtx("audit-bad");
    await expect(
      AuditLog.create({
        tenantId: tenantCtx.tenant._id,
        userId: tenantCtx.user._id,
        action: "foo.bar",
        entityType: "INVALID_TYPE",
      }),
    ).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────
// 2. TicketRemark tenantId isolation
// ────────────────────────────────────────────────
describe("TicketRemark — tenantId isolation", () => {
  let ctxA, ctxB, ticketA;

  beforeEach(async () => {
    ctxA = await createTenantCtx("tr-a");
    ctxB = await createTenantCtx("tr-b");

    ticketA = await Ticket.create({
      tenantId: ctxA.tenant._id,
      title: "Ticket for remark isolation",
      createdBy: ctxA.user._id,
      status: "open",
      priority: "medium",
    });
  });

  it("should store tenantId on created ticket remark", async () => {
    const remark = await TicketRemark.create({
      ticket: ticketA._id,
      user: ctxA.user._id,
      tenantId: ctxA.tenant._id,
      content: "remark with tenantId",
      type: "note",
    });

    expect(remark.tenantId.toString()).toBe(ctxA.tenant._id.toString());
  });

  it("should filter remarks by tenantId via API (same-tenant sees own)", async () => {
    await TicketRemark.create({
      ticket: ticketA._id,
      user: ctxA.user._id,
      tenantId: ctxA.tenant._id,
      content: "visible to A",
      type: "note",
    });

    const res = await request
      .get(`/api/v1/tickets/${ticketA._id}/remarks`)
      .set("Authorization", `Bearer ${ctxA.token}`);

    expect(res.status).toBe(200);
    const remarks = res.body.data?.remarks ?? res.body.data ?? [];
    expect(remarks.length).toBeGreaterThanOrEqual(1);
  });

  it("cross-tenant user should NOT see remarks via API", async () => {
    await TicketRemark.create({
      ticket: ticketA._id,
      user: ctxA.user._id,
      tenantId: ctxA.tenant._id,
      content: "hidden from B",
      type: "note",
    });

    const res = await request
      .get(`/api/v1/tickets/${ticketA._id}/remarks`)
      .set("Authorization", `Bearer ${ctxB.token}`);

    // Either 403/404 (ticket doesn't belong to B) or empty list
    if (res.status === 200) {
      const remarks = res.body.data?.remarks ?? res.body.data ?? [];
      expect(remarks.length).toBe(0);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });
});

// ────────────────────────────────────────────────
// 3. TicketRemark static helpers propagate tenantId
// ────────────────────────────────────────────────
describe("TicketRemark static helpers", () => {
  let ctx, ticket;

  beforeEach(async () => {
    ctx = await createTenantCtx("static-helpers");
    ticket = await Ticket.create({
      tenantId: ctx.tenant._id,
      title: "Static helper ticket",
      createdBy: ctx.user._id,
      status: "open",
      priority: "medium",
    });
  });

  it("createStatusChangeRemark stores tenantId", async () => {
    const remark = await TicketRemark.createStatusChangeRemark(
      ctx.tenant._id,
      ticket._id,
      ctx.user._id,
      "open",
      "in_progress",
    );

    expect(remark.tenantId).toBeDefined();
    expect(remark.tenantId.toString()).toBe(ctx.tenant._id.toString());
    expect(remark.type).toBe("status_change");
  });

  it("createAssignmentRemark stores tenantId", async () => {
    const remark = await TicketRemark.createAssignmentRemark(
      ctx.tenant._id,
      ticket._id,
      ctx.user._id,
      "Alice Doe",
    );

    expect(remark.tenantId).toBeDefined();
    expect(remark.tenantId.toString()).toBe(ctx.tenant._id.toString());
    expect(remark.type).toBe("assignment_change");
  });

  it("createStatusChangeRemark requires tenantId", async () => {
    await expect(
      TicketRemark.createStatusChangeRemark(
        null,
        ticket._id,
        ctx.user._id,
        "open",
        "closed",
      ),
    ).rejects.toThrow("tenantId is required");
  });
});

// ────────────────────────────────────────────────
// 4. LeadRemark tenantId isolation
// ────────────────────────────────────────────────
describe("LeadRemark — tenantId stored", () => {
  it("should persist tenantId on a lead remark", async () => {
    const ctx = await createTenantCtx("lr-tenant");

    // Need a website for the lead
    const Website =
      mongoose.models.Website ||
      (await import("../../src/models/Website.js")).default;
    const website = await Website.create({
      name: "LR Site",
      domain: "lr-test.com",
      tenantId: ctx.tenant._id,
      apiKey: "lr-api-key-12345",
      apiKeyPrefix: "lrpfx",
      createdBy: ctx.user._id,
    });

    const lead = await Lead.create({
      tenantId: ctx.tenant._id,
      firstName: "LeadRemark",
      email: "lr@test.com",
      websiteId: website._id,
      source: "contact_form",
    });

    const remark = await LeadRemark.create({
      lead: lead._id,
      user: ctx.user._id,
      tenantId: ctx.tenant._id,
      content: "Lead remark with tenantId",
      type: "note",
    });

    expect(remark.tenantId.toString()).toBe(ctx.tenant._id.toString());
  });
});

// ────────────────────────────────────────────────
// 5. Remark (client) tenantId isolation
// ────────────────────────────────────────────────
describe("Remark (client) — tenantId stored", () => {
  it("should persist tenantId on a client remark", async () => {
    const ctx = await createTenantCtx("cr-tenant");

    // Client model requires event + marketingPerson refs
    const Event =
      mongoose.models.Event ||
      (await import("../../src/models/Event.js")).default;
    const event = await Event.create({
      tenantId: ctx.tenant._id,
      name: "Test Event",
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      createdBy: ctx.user._id,
    });

    const client = await Client.create({
      tenantId: ctx.tenant._id,
      name: "Test Client",
      email: "client@cr-tenant.com",
      createdBy: ctx.user._id,
      event: event._id,
      marketingPerson: ctx.user._id,
    });

    const remark = await Remark.create({
      client: client._id,
      user: ctx.user._id,
      tenantId: ctx.tenant._id,
      content: "Client remark with tenantId",
      type: "note",
    });

    expect(remark.tenantId.toString()).toBe(ctx.tenant._id.toString());
  });
});

// ────────────────────────────────────────────────
// 6. Rate limiter configuration (unit-level)
// ────────────────────────────────────────────────
describe("Rate limiter exports", () => {
  it("should export bootstrapLimiter", async () => {
    const mod = await import("../../src/middlewares/rateLimiter.js");
    expect(mod.bootstrapLimiter).toBeDefined();
    expect(typeof mod.bootstrapLimiter).toBe("function");
  });

  it("should export apiLimiter", async () => {
    const mod = await import("../../src/middlewares/rateLimiter.js");
    expect(mod.apiLimiter).toBeDefined();
    expect(typeof mod.apiLimiter).toBe("function");
  });
});
