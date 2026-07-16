/**
 * Tests for P6-004d — WhatsApp admin health/reconnect UX support.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

let mongoServer;
let request;
let Tenant;
let User;
let ChannelAccount;
let IntegrationEvent;
let TokenVaultService;
let WhatsappCloudService;

async function createTenantCtx(slug = "wa-health") {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "growth",
  });
  const user = await User.create({
    name: `Admin ${slug}`,
    email: `${slug}@example.com`,
    password: "Password123!",
    role: "admin",
    tenantId: tenant._id,
    isActive: true,
    approvalStatus: "approved",
  });
  const token = jwt.sign(
    { id: String(user._id), tenantId: String(tenant._id), role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
  return { tenant, user, token };
}

async function createWhatsappAccount(tenant, user, overrides = {}) {
  const phoneNumberId = overrides.phoneNumberId || "987654321012345";
  const businessAccountId = overrides.businessAccountId || "123456789012345";
  return ChannelAccount.create({
    tenantId: tenant._id,
    provider: "whatsapp",
    providerAccountId: phoneNumberId,
    displayName: "Main WhatsApp",
    status: "connected",
    connectedBy: user._id,
    credentials: TokenVaultService.encryptJson(
      "whatsapp",
      {
        accessToken: "old-wa-token",
        businessAccountId,
        phoneNumberId,
      },
      { tenantId: tenant._id },
    ),
    providerMeta: {
      whatsapp: {
        businessAccountId,
        phoneNumberId,
        displayPhoneNumber: "+1 555 000 1111",
      },
    },
    ...overrides,
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 120000 },
  });
  await mongoose.connect(mongoServer.getUri());

  const appModule = await import("../../app.js");
  const supertest = await import("supertest");
  request = supertest.default(appModule.default);

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js")).default;
  IntegrationEvent = (await import("../../src/models/IntegrationEvent.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  WhatsappCloudService = (await import("../../src/services/whatsappCloudService.js"))
    .WhatsappCloudService;

  await ChannelAccount.syncIndexes();
  await IntegrationEvent.syncIndexes();
}, 120000);

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

beforeEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      quality_rating: "GREEN",
      messaging_limit_tier: "TIER_1K",
      status: "CONNECTED",
      name_status: "APPROVED",
      display_phone_number: "+1 555 000 1111",
      verified_name: "Main Support",
    }),
  }));
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("WhatsApp account health", () => {
  it("returns tenant-scoped account health, provider quality, and latest failures", async () => {
    const { tenant, user } = await createTenantCtx("health-a");
    const other = await createTenantCtx("health-b");
    const account = await createWhatsappAccount(tenant, user, {
      status: "error",
      consecutiveErrors: 2,
      lastError: "Token expired",
    });
    await createWhatsappAccount(other.tenant, other.user, {
      phoneNumberId: "111111111111111",
    });

    await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "whatsapp",
      eventType: "whatsapp.message",
      externalEventId: "message:failed-1",
      channelAccountId: account._id,
      status: "failed",
      statusReason: "Worker failed",
      signatureVerified: true,
    });
    await IntegrationEvent.create({
      tenantId: other.tenant._id,
      provider: "whatsapp",
      eventType: "whatsapp.message",
      externalEventId: "message:other-failed",
      channelAccountId: account._id,
      status: "failed",
      statusReason: "Cross tenant must not leak",
      signatureVerified: true,
    });

    const health = await WhatsappCloudService.listWhatsappAccountHealth(
      tenant._id,
    );

    expect(health).toHaveLength(1);
    expect(health[0].account.credentials).toBeUndefined();
    expect(health[0].status).toBe("error");
    expect(health[0].consecutiveErrors).toBe(2);
    expect(health[0].needsReconnect).toBe(true);
    expect(health[0].providerHealth.qualityRating).toBe("GREEN");
    expect(health[0].providerHealth.messagingLimitTier).toBe("TIER_1K");
    expect(health[0].latestFailures).toHaveLength(1);
    expect(health[0].latestFailures[0].statusReason).toBe("Worker failed");

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toContain("/987654321012345?");
    expect(url).toContain("quality_rating");
    expect(init.headers.Authorization).toBe("Bearer old-wa-token");
  });

  it("surfaces Graph rate-limit failures without mutating account state", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        error: { code: 4, message: "Application request limit reached" },
      }),
    }));
    const { tenant, user } = await createTenantCtx("rate-limit");
    const account = await createWhatsappAccount(tenant, user);

    const health = await WhatsappCloudService.getWhatsappAccountHealth(
      tenant._id,
      account._id,
    );

    expect(health.providerHealth.available).toBe(false);
    expect(health.providerHealth.rateLimited).toBe(true);
    expect(health.providerHealth.error).toBe("Application request limit reached");

    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.status).toBe("connected");
    expect(reloaded.lastError).toBeNull();
  });

  it("exposes the protected health route for admins", async () => {
    const { tenant, user, token } = await createTenantCtx("route-health");
    await createWhatsappAccount(tenant, user);

    const res = await request
      .get("/api/v1/integrations/whatsapp/accounts/health")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].account.provider).toBe("whatsapp");
    expect(res.body.data[0].account.credentials).toBeUndefined();
  });
});

describe("WhatsApp reconnect", () => {
  it("reconnects an errored account by re-uploading credentials", async () => {
    const { tenant, user, token } = await createTenantCtx("reconnect");
    const account = await createWhatsappAccount(tenant, user, {
      status: "error",
      consecutiveErrors: 3,
      lastError: "OAuth exception",
    });

    const res = await request
      .post(`/api/v1/integrations/whatsapp/accounts/${account._id}/reconnect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accessToken: "new-wa-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("connected");
    expect(res.body.data.consecutiveErrors).toBe(0);
    expect(res.body.data.lastError).toBeNull();
    expect(res.body.data.credentials).toBeUndefined();

    const withCreds = await ChannelAccount.findById(account._id).select(
      "+credentials",
    );
    const decrypted = TokenVaultService.decryptJson(
      "whatsapp",
      withCreds.credentials,
      { tenantId: tenant._id },
    );
    expect(decrypted.accessToken).toBe("new-wa-token");
    expect(decrypted.phoneNumberId).toBe(account.providerAccountId);
  });

  it("does not reconnect another tenant account", async () => {
    const owner = await createTenantCtx("owner");
    const attacker = await createTenantCtx("attacker");
    const account = await createWhatsappAccount(owner.tenant, owner.user);

    const res = await request
      .post(`/api/v1/integrations/whatsapp/accounts/${account._id}/reconnect`)
      .set("Authorization", `Bearer ${attacker.token}`)
      .send({ accessToken: "new-wa-token" });

    expect(res.status).toBe(404);
  });

  it("requires a replacement access token", async () => {
    const { tenant, user, token } = await createTenantCtx("missing-token");
    const account = await createWhatsappAccount(tenant, user);

    const res = await request
      .post(`/api/v1/integrations/whatsapp/accounts/${account._id}/reconnect`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("accessToken");
  });
});
