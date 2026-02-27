/**
 * Security tests for Ticket Remark BOLA vulnerability (P0-1)
 * and authenticated file access (P0-2)
 *
 * Tests verify:
 * - Cross-tenant remark update → 404
 * - Cross-tenant remark delete → 404
 * - Same-tenant remark update → 200
 * - Same-tenant remark delete → 200
 * - Unauthenticated file download → 401
 * - Cross-tenant file download → 404
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

// Set env before any app imports
process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = ""; // disable redis in tests

let mongoServer;
let app;
let request;

// Models
let Tenant, User, Ticket, TicketRemark, Lead;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Dynamic imports so env vars are already set
  const appModule = await import("../../app.js");
  app = appModule.default;

  const supertest = await import("supertest");
  request = supertest.default(app);

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  Ticket = (await import("../../src/models/Ticket.js")).default;
  TicketRemark = (await import("../../src/models/TicketRemark.js")).default;
  Lead = (await import("../../src/models/Lead.js")).default;
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

// Helper to create a tenant + admin user + token
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
    password: "$2b$10$dummyHashedPasswordForTesting1234567890ab", // bcrypt-like
    role: "admin",
    tenantId: tenant._id,
    isActive: true,
    isApproved: true,
  });
  const token = makeToken(user._id, tenant._id, "admin");
  return { tenant, user, token };
}

describe("P0-1: Ticket Remark BOLA — cross-tenant isolation", () => {
  let tenantA, tenantB;
  let ticketA, remarkA;

  beforeEach(async () => {
    tenantA = await createTenantCtx("tenant-a");
    tenantB = await createTenantCtx("tenant-b");

    ticketA = await Ticket.create({
      tenantId: tenantA.tenant._id,
      title: "Tenant A Ticket",
      createdBy: tenantA.user._id,
      status: "open",
      priority: "medium",
    });

    remarkA = await TicketRemark.create({
      ticket: ticketA._id,
      user: tenantA.user._id,
      content: "Original remark from Tenant A",
      type: "note",
    });
  });

  it("should allow same-tenant user to update their remark", async () => {
    const res = await request
      .put(`/api/v1/tickets/remarks/${remarkA._id}`)
      .set("Authorization", `Bearer ${tenantA.token}`)
      .send({ content: "Updated by same tenant" });

    expect(res.status).toBe(200);
    expect(res.body.data.remark.content).toBe("Updated by same tenant");
  });

  it("should BLOCK cross-tenant user from updating remark (BOLA)", async () => {
    const res = await request
      .put(`/api/v1/tickets/remarks/${remarkA._id}`)
      .set("Authorization", `Bearer ${tenantB.token}`)
      .send({ content: "Hacked by Tenant B" });

    // Should return 404 (not 200 or 403 — don't leak existence)
    expect(res.status).toBe(404);
  });

  it("should allow same-tenant user to delete their remark", async () => {
    const res = await request
      .delete(`/api/v1/tickets/remarks/${remarkA._id}`)
      .set("Authorization", `Bearer ${tenantA.token}`);

    expect(res.status).toBe(200);
    const deleted = await TicketRemark.findById(remarkA._id);
    expect(deleted).toBeNull();
  });

  it("should BLOCK cross-tenant user from deleting remark (BOLA)", async () => {
    const res = await request
      .delete(`/api/v1/tickets/remarks/${remarkA._id}`)
      .set("Authorization", `Bearer ${tenantB.token}`);

    expect(res.status).toBe(404);
    // Remark should still exist
    const stillExists = await TicketRemark.findById(remarkA._id);
    expect(stillExists).not.toBeNull();
  });

  it("should return 404 for non-existent remark ID", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request
      .put(`/api/v1/tickets/remarks/${fakeId}`)
      .set("Authorization", `Bearer ${tenantA.token}`)
      .send({ content: "test" });

    expect(res.status).toBe(404);
  });
});

describe("P0-2: File access requires authentication", () => {
  it("should reject unauthenticated file download with 401", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request.get(
      `/api/v1/files/lead-attachments/${fakeId}/test.pdf`,
    );

    expect(res.status).toBe(401);
  });

  it("should reject cross-tenant file download with 404", async () => {
    const tenantA = await createTenantCtx("file-tenant-a");
    const tenantB = await createTenantCtx("file-tenant-b");

    // Create a lead in tenant A
    const Website =
      mongoose.models.Website ||
      (await import("../../src/models/Website.js")).default;
    const website = await Website.create({
      name: "Test Site",
      domain: "test.com",
      tenantId: tenantA.tenant._id,
      apiKey: "test-api-key-12345",
      apiKeyPrefix: "test",
      createdBy: tenantA.user._id,
    });

    const lead = await Lead.create({
      tenantId: tenantA.tenant._id,
      firstName: "Test",
      email: "test@test.com",
      websiteId: website._id,
      source: "contact_form",
    });

    // Try to access Tenant A's lead files as Tenant B user
    const res = await request
      .get(`/api/v1/files/lead-attachments/${lead._id}/somefile.pdf`)
      .set("Authorization", `Bearer ${tenantB.token}`);

    expect(res.status).toBe(404);
  });

  it("should reject invalid file type with 400", async () => {
    const tenantA = await createTenantCtx("file-type-test");
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request
      .get(`/api/v1/files/invalid-type/${fakeId}/test.pdf`)
      .set("Authorization", `Bearer ${tenantA.token}`);

    expect(res.status).toBe(400);
  });

  it("should reject directory traversal attempts", async () => {
    const tenantA = await createTenantCtx("traversal-test");
    const fakeId = new mongoose.Types.ObjectId();

    const res = await request
      .get(`/api/v1/files/lead-attachments/${fakeId}/..%2F..%2Fetc%2Fpasswd`)
      .set("Authorization", `Bearer ${tenantA.token}`);

    // Should fail validation (filename regex rejects ..)
    expect([400, 404]).toContain(res.status);
  });

  it("old /uploads/ static path should return 404", async () => {
    const res = await request.get("/uploads/lead-attachments/someid/file.pdf");

    expect(res.status).toBe(404);
  });
});

describe("P1-1: PUT /tickets/:id/status requires RBAC", () => {
  it("should reject role 'user' from updating ticket status", async () => {
    const tenantCtx = await createTenantCtx("rbac-test");

    // Create a user with 'user' role
    const basicUser = await User.create({
      name: "Basic User",
      email: "user@rbac-test.com",
      password: "$2b$10$dummyHashedPasswordForTesting1234567890ab",
      role: "user",
      tenantId: tenantCtx.tenant._id,
      isActive: true,
      isApproved: true,
    });
    const userToken = makeToken(basicUser._id, tenantCtx.tenant._id, "user");

    const ticket = await Ticket.create({
      tenantId: tenantCtx.tenant._id,
      title: "RBAC Test Ticket",
      createdBy: tenantCtx.user._id,
      status: "open",
      priority: "medium",
    });

    const res = await request
      .put(`/api/v1/tickets/${ticket._id}/status`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ status: "closed" });

    expect(res.status).toBe(403);
  });

  it("should allow admin to update ticket status", async () => {
    const tenantCtx = await createTenantCtx("rbac-admin-test");

    const ticket = await Ticket.create({
      tenantId: tenantCtx.tenant._id,
      title: "Admin Status Test",
      createdBy: tenantCtx.user._id,
      status: "open",
      priority: "medium",
    });

    const res = await request
      .put(`/api/v1/tickets/${ticket._id}/status`)
      .set("Authorization", `Bearer ${tenantCtx.token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
  });
});
