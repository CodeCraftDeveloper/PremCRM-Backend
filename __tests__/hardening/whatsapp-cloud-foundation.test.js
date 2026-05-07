/**
 * Tests for P6-001 — WhatsApp Business Cloud API foundation.
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
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-whatsapp-token";
process.env.WHATSAPP_APP_SECRET = "whatsapp-app-secret";

let mongoServer;
let app;
let request;
let Tenant;
let User;
let ChannelAccount;
let ContactIdentity;
let Conversation;
let Message;
let IntegrationEvent;
let TokenVaultService;
let WhatsappCloudService;

const oid = () => new mongoose.Types.ObjectId();

function signBody(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    raw,
    signature:
      "sha256=" +
      crypto
        .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
        .update(raw)
        .digest("hex"),
  };
}

function whatsappPayload(overrides = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123456789012345",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: "987654321012345",
              },
              contacts: [
                {
                  profile: { name: "Alice Customer" },
                  wa_id: "15550002222",
                },
              ],
              messages: [
                {
                  from: "15550002222",
                  id: "wamid.test-message-1",
                  timestamp: "1770000000",
                  type: "text",
                  text: { body: "Hi, I need pricing" },
                },
              ],
              ...overrides.value,
            },
            ...overrides.change,
          },
        ],
      },
    ],
  };
}

async function createTenantCtx(slug = "wa") {
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
  return ChannelAccount.create({
    tenantId: tenant._id,
    provider: "whatsapp",
    providerAccountId: overrides.phoneNumberId || "987654321012345",
    displayName: "Main WhatsApp",
    connectedBy: user._id,
    credentials: TokenVaultService.encryptJson(
      "whatsapp",
      {
        accessToken: "wa-token",
        businessAccountId: "123456789012345",
        phoneNumberId: overrides.phoneNumberId || "987654321012345",
      },
      { tenantId: tenant._id },
    ),
    providerMeta: {
      whatsapp: {
        businessAccountId: "123456789012345",
        phoneNumberId: overrides.phoneNumberId || "987654321012345",
      },
    },
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
  ContactIdentity = (await import("../../src/models/inbox/ContactIdentity.js")).default;
  Conversation = (await import("../../src/models/inbox/Conversation.js")).default;
  Message = (await import("../../src/models/inbox/Message.js")).default;
  IntegrationEvent = (await import("../../src/models/IntegrationEvent.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  WhatsappCloudService = (await import("../../src/services/whatsappCloudService.js"))
    .WhatsappCloudService;

  await ChannelAccount.syncIndexes();
  await ContactIdentity.syncIndexes();
  await Conversation.syncIndexes();
  await Message.syncIndexes();
  await IntegrationEvent.syncIndexes();
}, 30000);

afterAll(async () => {
  vi.restoreAllMocks();
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

describe("WhatsApp account connection", () => {
  it("connects a WhatsApp account with encrypted credentials", async () => {
    const { tenant, user } = await createTenantCtx("connect");

    const account = await WhatsappCloudService.connectWhatsappAccount(
      tenant._id,
      user._id,
      {
        phoneNumberId: "987654321012345",
        businessAccountId: "123456789012345",
        accessToken: "secret-wa-token",
        displayName: "Support WhatsApp",
        displayPhoneNumber: "+1 555 000 1111",
      },
    );

    expect(account.provider).toBe("whatsapp");
    expect(account.providerAccountId).toBe("987654321012345");
    const withCreds = await ChannelAccount.findById(account._id).select(
      "+credentials",
    );
    expect(withCreds.credentials.accessToken).toBeUndefined();
    const decrypted = TokenVaultService.decryptJson(
      "whatsapp",
      withCreds.credentials,
      { tenantId: tenant._id },
    );
    expect(decrypted.accessToken).toBe("secret-wa-token");
  });

  it("exposes protected account routes behind auth and plan gate", async () => {
    const { token } = await createTenantCtx("route-connect");
    const res = await request
      .post("/api/v1/integrations/whatsapp/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        phoneNumberId: "987654321012345",
        businessAccountId: "123456789012345",
        accessToken: "route-token",
        displayName: "Route WhatsApp",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe("whatsapp");
    expect(res.body.data.credentials).toBeUndefined();
  });
});

describe("WhatsApp webhook verification and ingest", () => {
  it("responds with the Meta challenge for a valid verification request", async () => {
    const res = await request
      .get("/api/v1/integrations/whatsapp/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-whatsapp-token",
        "hub.challenge": "challenge-123",
      });

    expect(res.status).toBe(200);
    expect(res.text).toBe("challenge-123");
  });

  it("rejects an invalid webhook challenge token", async () => {
    const res = await request
      .get("/api/v1/integrations/whatsapp/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge-123",
      });

    expect(res.status).toBe(403);
  });

  it("ingests a signed inbound message and dedupes replay by message id", async () => {
    const { tenant, user } = await createTenantCtx("ingest");
    await createWhatsappAccount(tenant, user);
    const body = whatsappPayload();
    const { signature } = signBody(body);

    const first = await request
      .post("/api/v1/integrations/whatsapp/webhook")
      .set("X-Hub-Signature-256", signature)
      .send(body);
    const replay = await request
      .post("/api/v1/integrations/whatsapp/webhook")
      .set("X-Hub-Signature-256", signature)
      .send(body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(
      await IntegrationEvent.countDocuments({
        provider: "whatsapp",
        externalEventId: "message:wamid.test-message-1",
      }),
    ).toBe(1);

    const event = await IntegrationEvent.findOne({
      externalEventId: "message:wamid.test-message-1",
    });
    expect(String(event.tenantId)).toBe(String(tenant._id));
    expect(["received", "enqueued"]).toContain(event.status);
    expect(event.signatureVerified).toBe(true);
  });

  it("stores unknown phone-number events as skipped", async () => {
    const body = whatsappPayload();
    const { signature } = signBody(body);

    const res = await request
      .post("/api/v1/integrations/whatsapp/webhook")
      .set("X-Hub-Signature-256", signature)
      .send(body);

    expect(res.status).toBe(200);
    const event = await IntegrationEvent.findOne({
      externalEventId: "message:wamid.test-message-1",
    });
    expect(event.status).toBe("skipped");
    expect(event.tenantId).toBeNull();
    expect(event.statusReason).toContain("no-channel-account-for-");
  });

  it("rejects a webhook with an invalid app-secret signature", async () => {
    const res = await request
      .post("/api/v1/integrations/whatsapp/webhook")
      .set("X-Hub-Signature-256", "sha256=bad")
      .send(whatsappPayload());

    expect(res.status).toBe(401);
  });
});

describe("WhatsApp message processor", () => {
  it("normalises an inbound WhatsApp text message into the unified inbox", async () => {
    const { processWhatsappMessage } = await import(
      "../../src/queue/processors/whatsappMessageProcessor.js"
    );
    const { tenant, user } = await createTenantCtx("processor");
    const account = await createWhatsappAccount(tenant, user);
    const event = await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "whatsapp",
      eventType: "whatsapp.message",
      externalEventId: "message:wamid.processor-1",
      channelAccountId: account._id,
      signatureVerified: true,
      payload: {
        kind: "message",
        phoneNumberId: account.providerAccountId,
        contact: {
          profile: { name: "Alice Customer" },
          wa_id: "15550002222",
        },
        message: {
          from: "15550002222",
          id: "wamid.processor-1",
          timestamp: "1770000000",
          type: "text",
          text: { body: "Need a quote" },
        },
      },
    });

    const result = await processWhatsappMessage({
      id: "wa-job-1",
      data: {
        tenantId: String(tenant._id),
        integrationEventId: String(event._id),
      },
    });

    expect(result.imported).toBe(1);
    const identity = await ContactIdentity.findOne({
      tenantId: tenant._id,
      provider: "whatsapp",
      providerIdentifier: "+15550002222",
    });
    expect(identity.displayName).toBe("Alice Customer");

    const conversation = await Conversation.findOne({
      tenantId: tenant._id,
      channel: "whatsapp",
    });
    expect(conversation.unreadCount).toBe(1);
    expect(conversation.lastMessageSnippet).toBe("Need a quote");

    const message = await Message.findOne({
      tenantId: tenant._id,
      providerMessageId: "wamid.processor-1",
    });
    expect(message.body).toBe("Need a quote");
    expect(message.direction).toBe("inbound");
  });

  it("updates delivery status events against existing outbound messages", async () => {
    const { processWhatsappMessage } = await import(
      "../../src/queue/processors/whatsappMessageProcessor.js"
    );
    const { tenant, user } = await createTenantCtx("status");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await Conversation.create({
      tenantId: tenant._id,
      channelAccountId: account._id,
      channel: "whatsapp",
      providerThreadId: "+15550002222:987654321012345",
    });
    await Message.create({
      tenantId: tenant._id,
      conversationId: conversation._id,
      channelAccountId: account._id,
      channel: "whatsapp",
      direction: "outbound",
      status: "sent",
      providerMessageId: "wamid.outbound-status",
      body: "Hello",
    });
    const event = await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "whatsapp",
      eventType: "whatsapp.status",
      externalEventId: "status:wamid.outbound-status:delivered:1770000010",
      channelAccountId: account._id,
      signatureVerified: true,
      payload: {
        kind: "status",
        status: {
          id: "wamid.outbound-status",
          status: "delivered",
          timestamp: "1770000010",
        },
      },
    });

    await processWhatsappMessage({
      id: "wa-status-job",
      data: {
        tenantId: String(tenant._id),
        integrationEventId: String(event._id),
      },
    });

    const message = await Message.findOne({
      tenantId: tenant._id,
      providerMessageId: "wamid.outbound-status",
    });
    expect(message.status).toBe("delivered");
    expect(message.deliveredAt).toBeTruthy();
  });
});
