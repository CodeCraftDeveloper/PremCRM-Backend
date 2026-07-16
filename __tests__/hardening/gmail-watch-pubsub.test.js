/**
 * Tests for P5-002 — Gmail Watch Renewal & Pub/Sub Webhook Foundation.
 *
 * Coverage:
 *   1. IntegrationEvent dedup + tenant scoping + 90-day TTL.
 *   2. Pub/Sub verification helper — token mismatch, missing token, no env.
 *   3. gmailWatchService.startWatch persists historyId/expiration onto
 *      ChannelAccount.providerMeta.gmailWatch and mirrors syncCursor.
 *   4. gmailWatchService.stopWatch clears the watch metadata.
 *   5. gmailWatchService.findAccountsNeedingRenewal returns accounts whose
 *      watch is missing or expiring within the renewal window.
 *   6. gmailWatchService.runRenewalPass isolates per-account failures.
 *   7. decodePubsubEnvelope handles base64 JSON + bad payloads.
 *   8. ingestGmailPubsubEvent records new events, dedupes by messageId,
 *      and skips when no ChannelAccount maps to the email address.
 *   9. POST /api/v1/integrations/google/pubsub/gmail/push verifies the
 *      shared token, returns 204 on success and dedup, 401 on bad token,
 *      400 on malformed envelope.
 *  10. inboundWebhookProcessor marks IntegrationEvent processed and
 *      throws NonRetryableError on missing tenantId/integrationEventId.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI =
  "http://localhost:5000/api/v1/integrations/google/oauth/callback";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.GOOGLE_PUBSUB_TOPIC = "projects/test-project/topics/gmail-history";
process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN = "test-pubsub-token";

let mongoServer;
let app;
let request;

let Tenant;
let User;
let ChannelAccount;
let IntegrationEvent;
let TokenVaultService;
let GmailWatchService;
let GmailPubsubIngestService;
let PubsubVerification;

const oid = () => new mongoose.Types.ObjectId();

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

async function createTenantCtx(slug = "p5-002") {
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
  return { tenant, user };
}

async function createGmailAccount(tenant, user, providerAccountId, overrides = {}) {
  return ChannelAccount.create({
    tenantId: tenant._id,
    provider: "gmail",
    providerAccountId,
    displayName: providerAccountId,
    connectedBy: user._id,
    scopes: ["openid", "email"],
    credentials: TokenVaultService.encryptJson(
      "gmail",
      {
        accessToken: "access-token-fresh",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scopes: ["openid", "email"],
      },
      { tenantId: tenant._id },
    ),
    ...overrides,
  });
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
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js")).default;
  IntegrationEvent = (await import("../../src/models/IntegrationEvent.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  GmailWatchService = (await import("../../src/services/gmailWatchService.js"))
    .GmailWatchService;
  GmailPubsubIngestService = await import(
    "../../src/services/gmailPubsubIngestService.js"
  );
  PubsubVerification = (
    await import("../../src/services/pubsubVerificationService.js")
  ).PubsubVerification;

  await ChannelAccount.syncIndexes();
  await IntegrationEvent.syncIndexes();
}, 30000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  vi.restoreAllMocks();
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("IntegrationEvent model", () => {
  it("dedupes by (provider, externalEventId)", async () => {
    const tenantId = oid();
    await IntegrationEvent.create({
      provider: "gmail",
      eventType: "gmail.history",
      externalEventId: "msg-001",
      tenantId,
      payload: { hello: "world" },
    });

    await expect(
      IntegrationEvent.create({
        provider: "gmail",
        eventType: "gmail.history",
        externalEventId: "msg-001",
        tenantId,
      }),
    ).rejects.toThrow();
  });

  it("permits the same externalEventId across different providers", async () => {
    await IntegrationEvent.create({
      provider: "gmail",
      eventType: "gmail.history",
      externalEventId: "shared-id",
      tenantId: oid(),
    });
    const created = await IntegrationEvent.create({
      provider: "whatsapp",
      eventType: "whatsapp.message",
      externalEventId: "shared-id",
      tenantId: oid(),
    });
    expect(created.provider).toBe("whatsapp");
  });

  it("registers a TTL index on createdAt with ~90-day expiry", async () => {
    const indexes = await IntegrationEvent.collection.indexes();
    const ttl = indexes.find((idx) => idx.expireAfterSeconds);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(60 * 60 * 24 * 90);
  });
});

describe("PubsubVerification.verifyPubsubPush", () => {
  it("accepts a request with a matching shared token", () => {
    const result = PubsubVerification.verifyPubsubPush({
      query: { token: "test-pubsub-token" },
      headers: {},
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("rejects requests with a wrong token", () => {
    const result = PubsubVerification.verifyPubsubPush({
      query: { token: "wrong" },
      headers: {},
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("token-mismatch");
  });

  it("rejects requests without a token", () => {
    const result = PubsubVerification.verifyPubsubPush({
      query: {},
      headers: {},
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing-token");
  });

  it("returns verification-token-not-configured when env is empty", () => {
    const original = process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
    process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN = "";
    try {
      const result = PubsubVerification.verifyPubsubPush({
        query: { token: "anything" },
        headers: {},
      });
      expect(result.verified).toBe(false);
      expect(result.reason).toBe("verification-token-not-configured");
    } finally {
      process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN = original;
    }
  });

  it("flags presence of a Bearer JWT for downstream upgrade", () => {
    const result = PubsubVerification.verifyPubsubPush({
      query: { token: "test-pubsub-token" },
      headers: { authorization: "Bearer test.jwt.value" },
    });
    expect(result.hasBearer).toBe(true);
  });
});

describe("GmailWatchService", () => {
  it("startWatch persists watch metadata and mirrors syncCursor", async () => {
    const { tenant, user } = await createTenantCtx("watch-start");
    const account = await createGmailAccount(tenant, user, "watch@example.com");

    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain("gmail.googleapis.com");
      return jsonResponse({
        historyId: "1234567890",
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await GmailWatchService.startWatch(tenant._id, account._id);
    expect(result.historyId).toBe("1234567890");
    expect(result.topicName).toBe(process.env.GOOGLE_PUBSUB_TOPIC);

    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.providerMeta.gmailWatch.historyId).toBe("1234567890");
    expect(reloaded.providerMeta.gmailWatch.topicName).toBe(
      process.env.GOOGLE_PUBSUB_TOPIC,
    );
    expect(reloaded.syncCursor).toBe("1234567890");
    expect(reloaded.consecutiveErrors).toBe(0);
  });

  it("startWatch refuses without a topic configured", async () => {
    const original = process.env.GOOGLE_PUBSUB_TOPIC;
    process.env.GOOGLE_PUBSUB_TOPIC = "";
    try {
      const { tenant, user } = await createTenantCtx("watch-no-topic");
      const account = await createGmailAccount(tenant, user, "watch-x@example.com");
      await expect(
        GmailWatchService.startWatch(tenant._id, account._id),
      ).rejects.toThrow(/topic is not configured/i);
    } finally {
      process.env.GOOGLE_PUBSUB_TOPIC = original;
    }
  });

  it("stopWatch clears the gmailWatch metadata", async () => {
    const { tenant, user } = await createTenantCtx("watch-stop");
    const account = await createGmailAccount(tenant, user, "stop@example.com", {
      providerMeta: {
        gmailWatch: {
          topicName: process.env.GOOGLE_PUBSUB_TOPIC,
          historyId: "111",
          expiration: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));

    await GmailWatchService.stopWatch(tenant._id, account._id);
    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.providerMeta.gmailWatch).toBeUndefined();
  });

  it("findAccountsNeedingRenewal selects expiring and missing watches", async () => {
    const { tenant, user } = await createTenantCtx("renew-scan");
    const expired = await createGmailAccount(tenant, user, "expired@x.com", {
      providerMeta: {
        gmailWatch: {
          historyId: "1",
          expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const fresh = await createGmailAccount(tenant, user, "fresh@x.com", {
      providerMeta: {
        gmailWatch: {
          historyId: "2",
          expiration: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const missing = await createGmailAccount(tenant, user, "missing@x.com");

    const candidates = await GmailWatchService.findAccountsNeedingRenewal();
    const ids = candidates.map((acc) => String(acc._id)).sort();
    expect(ids).toContain(String(expired._id));
    expect(ids).toContain(String(missing._id));
    expect(ids).not.toContain(String(fresh._id));
  });

  it("runRenewalPass isolates per-account failures and reports counts", async () => {
    const { tenant, user } = await createTenantCtx("renew-pass");
    const a = await createGmailAccount(tenant, user, "a@x.com");
    const b = await createGmailAccount(tenant, user, "b@x.com");

    const fetchMock = vi.fn(async (url, options = {}) => {
      const body = String(options.body || "");
      if (body.includes('"topicName"') || url.toString().includes("/watch")) {
        if (fetchMock.mock.calls.length % 2 === 1) {
          return jsonResponse({
            historyId: "100",
            expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
        }
        return jsonResponse({ error: { message: "boom" } }, false);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await GmailWatchService.runRenewalPass();
    expect(summary.scanned).toBe(2);
    expect(summary.renewed + summary.failures.length).toBe(2);
    expect(summary.failures.length).toBeGreaterThanOrEqual(1);
    // Sanity: every failure entry references one of our accounts.
    for (const failure of summary.failures) {
      expect([String(a._id), String(b._id)]).toContain(
        failure.channelAccountId,
      );
    }
  });
});

describe("decodePubsubEnvelope", () => {
  it("decodes base64 JSON data", () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: "Sales@Example.com", historyId: "42" }),
      "utf8",
    ).toString("base64");
    const decoded = GmailPubsubIngestService.decodePubsubEnvelope({
      message: { messageId: "m1", publishTime: "2026-01-01T00:00:00Z", data },
      subscription: "projects/p/subscriptions/s",
    });
    expect(decoded.messageId).toBe("m1");
    expect(decoded.data.historyId).toBe("42");
  });

  it("returns null for malformed bodies", () => {
    expect(GmailPubsubIngestService.decodePubsubEnvelope(null)).toBeNull();
    expect(GmailPubsubIngestService.decodePubsubEnvelope({})).toBeNull();
    expect(
      GmailPubsubIngestService.decodePubsubEnvelope({ message: {} }),
    ).toBeNull();
  });

  it("survives non-JSON data fields", () => {
    const decoded = GmailPubsubIngestService.decodePubsubEnvelope({
      message: { messageId: "m2", data: "not-base64-json" },
    });
    expect(decoded.messageId).toBe("m2");
    expect(decoded.data).toBeNull();
  });
});

describe("ingestGmailPubsubEvent", () => {
  it("records a new event when an account matches the email address", async () => {
    const { tenant, user } = await createTenantCtx("ingest-match");
    await createGmailAccount(tenant, user, "match@example.com");

    const data = Buffer.from(
      JSON.stringify({ emailAddress: "match@example.com", historyId: "99" }),
      "utf8",
    ).toString("base64");
    const envelope = GmailPubsubIngestService.decodePubsubEnvelope({
      message: { messageId: "m-match-1", data },
    });

    const { event, deduplicated } =
      await GmailPubsubIngestService.ingestGmailPubsubEvent({
        envelope,
        signatureVerified: true,
      });
    expect(deduplicated).toBe(false);
    expect(String(event.tenantId)).toBe(String(tenant._id));
    // Without Redis, enqueue returns null, so status remains "received".
    expect(["received", "enqueued"]).toContain(event.status);
    expect(event.signatureVerified).toBe(true);
  });

  it("dedupes a duplicate Pub/Sub messageId", async () => {
    const { tenant, user } = await createTenantCtx("ingest-dup");
    await createGmailAccount(tenant, user, "dup@example.com");

    const data = Buffer.from(
      JSON.stringify({ emailAddress: "dup@example.com", historyId: "1" }),
      "utf8",
    ).toString("base64");
    const envelope = GmailPubsubIngestService.decodePubsubEnvelope({
      message: { messageId: "m-dup-1", data },
    });

    const first = await GmailPubsubIngestService.ingestGmailPubsubEvent({
      envelope,
      signatureVerified: true,
    });
    const second = await GmailPubsubIngestService.ingestGmailPubsubEvent({
      envelope,
      signatureVerified: true,
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    const count = await IntegrationEvent.countDocuments({
      externalEventId: "m-dup-1",
    });
    expect(count).toBe(1);
  });

  it("marks events skipped when no ChannelAccount maps to the email", async () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: "unknown@example.com", historyId: "1" }),
      "utf8",
    ).toString("base64");
    const envelope = GmailPubsubIngestService.decodePubsubEnvelope({
      message: { messageId: "m-skip-1", data },
    });

    const { event } = await GmailPubsubIngestService.ingestGmailPubsubEvent({
      envelope,
      signatureVerified: true,
    });
    expect(event.status).toBe("skipped");
    expect(event.statusReason).toContain("no-channel-account-for-");
    expect(event.tenantId).toBeNull();
  });
});

describe("POST /api/v1/integrations/google/pubsub/gmail/push", () => {
  it("returns 401 with a wrong verification token", async () => {
    const res = await request
      .post("/api/v1/integrations/google/pubsub/gmail/push?token=nope")
      .send({ message: { messageId: "x" } });
    expect(res.status).toBe(401);
  });

  it("returns 400 when envelope is missing", async () => {
    const res = await request
      .post("/api/v1/integrations/google/pubsub/gmail/push?token=test-pubsub-token")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 204 on success and 204 on duplicate replay", async () => {
    const { tenant, user } = await createTenantCtx("push-204");
    await createGmailAccount(tenant, user, "push@example.com");

    const data = Buffer.from(
      JSON.stringify({ emailAddress: "push@example.com", historyId: "1" }),
      "utf8",
    ).toString("base64");

    const first = await request
      .post("/api/v1/integrations/google/pubsub/gmail/push?token=test-pubsub-token")
      .send({
        message: { messageId: "m-204-1", data, publishTime: "2026-01-01" },
        subscription: "projects/x/subscriptions/y",
      });
    expect(first.status).toBe(204);

    const replay = await request
      .post("/api/v1/integrations/google/pubsub/gmail/push?token=test-pubsub-token")
      .send({
        message: { messageId: "m-204-1", data, publishTime: "2026-01-01" },
      });
    expect(replay.status).toBe(204);

    const events = await IntegrationEvent.find({
      externalEventId: "m-204-1",
    });
    expect(events).toHaveLength(1);
  });
});

describe("inboundWebhookProcessor", () => {
  it("marks an IntegrationEvent processed (placeholder ack for non-gmail providers)", async () => {
    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );
    const tenantId = oid();
    const event = await IntegrationEvent.create({
      tenantId,
      provider: "whatsapp",
      eventType: "whatsapp.message",
      externalEventId: "p-1",
      status: "received",
    });

    const result = await processInboundWebhook({
      id: "job-1",
      data: {
        tenantId: String(tenantId),
        provider: "whatsapp",
        integrationEventId: String(event._id),
      },
    });
    expect(result.eventId).toBe(String(event._id));
    expect(result.pendingSync).toBe(false);

    const reloaded = await IntegrationEvent.findById(event._id);
    expect(reloaded.status).toBe("processed");
    expect(reloaded.processedAt).toBeTruthy();
  });

  it("throws NonRetryableError on missing tenantId", async () => {
    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );
    const { NonRetryableError } = await import("../../src/queue/errors.js");
    await expect(
      processInboundWebhook({ id: "j", data: { provider: "gmail" } }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("throws NonRetryableError when the event is not found", async () => {
    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );
    const { NonRetryableError } = await import("../../src/queue/errors.js");
    await expect(
      processInboundWebhook({
        id: "j",
        data: {
          tenantId: String(oid()),
          provider: "gmail",
          integrationEventId: String(oid()),
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
