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
let Event;
let Client;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function createTenantCtx(slug) {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "pro",
    subscription: { status: "active" },
  });

  const admin = await User.create({
    name: `Admin ${slug}`,
    email: `admin@${slug}.com`,
    password: "Password123!",
    role: "admin",
    tenantId: tenant._id,
    approvalStatus: "approved",
    isActive: true,
  });

  const marketerOne = await User.create({
    name: `Marketer One ${slug}`,
    email: `marketer-one@${slug}.com`,
    password: "Password123!",
    role: "marketing",
    tenantId: tenant._id,
    approvalStatus: "approved",
    isActive: true,
  });

  const marketerTwo = await User.create({
    name: `Marketer Two ${slug}`,
    email: `marketer-two@${slug}.com`,
    password: "Password123!",
    role: "marketing",
    tenantId: tenant._id,
    approvalStatus: "approved",
    isActive: true,
  });

  const token = makeToken(admin._id, tenant._id, "admin");
  return { tenant, admin, marketerOne, marketerTwo, token };
}

async function seedClient({
  tenantId,
  eventId,
  marketingPerson,
  createdBy,
  source,
  followUpStatus,
  estimatedValue,
  createdAt,
  convertedDate,
  suffix,
}) {
  const client = await Client.create({
    tenantId,
    name: `Client ${suffix}`,
    companyName: `Company ${suffix}`,
    email: `client-${suffix}@example.com`,
    phone: "+919999999999",
    event: eventId,
    marketingPerson,
    createdBy,
    source,
    followUpStatus,
    estimatedValue,
    priority: "medium",
    isActive: true,
    convertedDate: convertedDate || null,
  });

  await Client.collection.updateOne(
    { _id: client._id },
    {
      $set: {
        createdAt,
        updatedAt: createdAt,
        convertedDate: convertedDate || null,
      },
    },
  );

  return client;
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
  Event = (await import("../../src/models/Event.js")).default;
  Client = (await import("../../src/models/Client.js")).default;
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

describe("Dashboard analytics contract", () => {
  it("returns filtered summary, funnel, ROI, and source options for reports UI", async () => {
    const ctx = await createTenantCtx("analytics-contract");

    const eventOne = await Event.create({
      tenantId: ctx.tenant._id,
      name: "Revenue Summit",
      description: "Primary campaign event",
      location: "Bengaluru",
      startDate: new Date("2026-03-10T09:00:00.000Z"),
      endDate: new Date("2026-03-12T18:00:00.000Z"),
      budget: 1000,
      createdBy: ctx.admin._id,
    });

    const eventTwo = await Event.create({
      tenantId: ctx.tenant._id,
      name: "Partner Expo",
      description: "Secondary event",
      location: "Mumbai",
      startDate: new Date("2026-03-15T09:00:00.000Z"),
      endDate: new Date("2026-03-16T18:00:00.000Z"),
      budget: 500,
      createdBy: ctx.admin._id,
    });

    await seedClient({
      tenantId: ctx.tenant._id,
      eventId: eventOne._id,
      marketingPerson: ctx.marketerOne._id,
      createdBy: ctx.admin._id,
      source: "website",
      followUpStatus: "converted",
      estimatedValue: 3000,
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      convertedDate: new Date("2026-03-03T10:00:00.000Z"),
      suffix: "filtered-converted",
    });

    await seedClient({
      tenantId: ctx.tenant._id,
      eventId: eventOne._id,
      marketingPerson: ctx.marketerOne._id,
      createdBy: ctx.admin._id,
      source: "website",
      followUpStatus: "interested",
      estimatedValue: 1500,
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
      convertedDate: null,
      suffix: "filtered-pipeline",
    });

    await seedClient({
      tenantId: ctx.tenant._id,
      eventId: eventOne._id,
      marketingPerson: ctx.marketerTwo._id,
      createdBy: ctx.admin._id,
      source: "referral",
      followUpStatus: "converted",
      estimatedValue: 2000,
      createdAt: new Date("2026-03-02T15:00:00.000Z"),
      convertedDate: new Date("2026-03-04T09:00:00.000Z"),
      suffix: "wrong-marketer",
    });

    await seedClient({
      tenantId: ctx.tenant._id,
      eventId: eventTwo._id,
      marketingPerson: ctx.marketerOne._id,
      createdBy: ctx.admin._id,
      source: "website",
      followUpStatus: "converted",
      estimatedValue: 2500,
      createdAt: new Date("2026-03-02T16:00:00.000Z"),
      convertedDate: new Date("2026-03-03T16:00:00.000Z"),
      suffix: "wrong-event",
    });

    const response = await request
      .get("/api/v1/dashboard/analytics")
      .set("Authorization", `Bearer ${ctx.token}`)
      .query({
        startDate: "2026-03-01",
        endDate: "2026-03-03",
        eventId: eventOne._id.toString(),
        marketerId: ctx.marketerOne._id.toString(),
        source: "website",
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const payload = response.body.data;
    expect(payload.filters).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-03",
      eventId: eventOne._id.toString(),
      marketerId: ctx.marketerOne._id.toString(),
      source: "website",
    });

    expect(payload.summary).toMatchObject({
      totalClients: 2,
      convertedClients: 1,
      totalPipelineValue: 4500,
      realizedRevenue: 3000,
    });
    expect(payload.summary.conversionRate).toBe(50);

    expect(payload.roiSummary).toMatchObject({
      totalBudget: 1000,
      totalPipelineValue: 4500,
      realizedRevenue: 3000,
      roi: 200,
    });

    expect(payload.availableSources).toEqual(["website"]);

    expect(payload.statusDistribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: "converted", count: 1, value: 3000 }),
        expect.objectContaining({ _id: "interested", count: 1, value: 1500 }),
      ]),
    );

    expect(payload.sourceDistribution).toEqual([
      expect.objectContaining({ _id: "website", count: 2, value: 4500 }),
    ]);

    expect(payload.dailyTrend).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: "2026-03-01",
          count: 1,
          converted: 1,
          revenue: 3000,
        }),
        expect.objectContaining({
          _id: "2026-03-02",
          count: 1,
          converted: 0,
          revenue: 0,
        }),
      ]),
    );

    expect(payload.revenueFunnel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "interested",
          count: 1,
          revenue: 1500,
        }),
        expect.objectContaining({
          stage: "converted",
          count: 1,
          revenue: 3000,
          realizedRevenue: 3000,
        }),
      ]),
    );

    expect(payload.roiByEvent).toEqual([
      expect.objectContaining({
        eventId: eventOne._id.toString(),
        eventName: "Revenue Summit",
        budget: 1000,
        leadCount: 2,
        convertedCount: 1,
        pipelineValue: 4500,
        realizedRevenue: 3000,
        conversionRate: 50,
        roi: 200,
      }),
    ]);

    expect(payload.conversionTime.avgDays).toBe(2);
    expect(payload.conversionTime.minDays).toBe(2);
    expect(payload.conversionTime.maxDays).toBe(2);
  });
});
