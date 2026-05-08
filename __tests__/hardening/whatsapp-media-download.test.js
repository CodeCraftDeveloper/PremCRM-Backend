/**
 * Tests for P6-004a — WhatsApp inbound media download to S3.
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
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.WHATSAPP_GRAPH_API_VERSION = "v20.0";

// Mock the S3 helper before any module that imports it loads.
const uploadMock = vi.fn();
vi.mock("../../src/config/s3.js", () => ({
  uploadToS3: (...args) => uploadMock(...args),
}));

let mongoServer;
let Tenant;
let User;
let ChannelAccount;
let Conversation;
let ContactIdentity;
let Message;
let IntegrationEvent;
let TokenVaultService;
let WhatsappMediaService;
let WhatsappMediaPermanentError;
let WhatsappMediaTransientError;
let WhatsappMessageSyncService;
let processWhatsappMessage;

function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    headers: {
      get: (key) => headers[key.toLowerCase()] || null,
    },
  };
}

function bytesResponse(buffer, { ok = true, status = 200, mime = "image/jpeg" } = {}) {
  return {
    ok,
    status,
    arrayBuffer: async () => buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
    headers: {
      get: (key) =>
        key.toLowerCase() === "content-type" ? mime : null,
    },
  };
}

async function createTenantCtx(slug = "media") {
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

async function createWhatsappAccount(tenant, user, overrides = {}) {
  const phoneNumberId = overrides.phoneNumberId || "987654321012345";
  return ChannelAccount.create({
    tenantId: tenant._id,
    provider: "whatsapp",
    providerAccountId: phoneNumberId,
    displayName: "Main WhatsApp",
    connectedBy: user._id,
    status: overrides.status || "connected",
    credentials: TokenVaultService.encryptJson(
      "whatsapp",
      {
        accessToken: "wa-token",
        businessAccountId: "123456789012345",
        phoneNumberId,
      },
      { tenantId: tenant._id },
    ),
    providerMeta: {
      whatsapp: {
        businessAccountId: "123456789012345",
        phoneNumberId,
      },
    },
    ...overrides,
  });
}

async function createInboundMediaMessage(tenant, account, overrides = {}) {
  const conversation = await Conversation.create({
    tenantId: tenant._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    providerThreadId: "+15550002222:987654321012345",
    participantName: "Alice Customer",
    status: "open",
  });
  const message = await Message.create({
    tenantId: tenant._id,
    conversationId: conversation._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    direction: "inbound",
    status: "sent",
    contentType: overrides.contentType || "image",
    body: overrides.body || "[image]",
    providerMessageId: `wamid.media-${conversation._id}`,
    providerTimestamp: new Date(),
    attachments: [
      {
        filename: overrides.filename ?? null,
        mimeType: overrides.mimeType ?? null,
        providerMediaId: overrides.providerMediaId ?? "media-id-abc",
      },
    ],
  });
  return { conversation, message };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js"))
    .default;
  ContactIdentity = (await import("../../src/models/inbox/ContactIdentity.js"))
    .default;
  Conversation = (await import("../../src/models/inbox/Conversation.js"))
    .default;
  Message = (await import("../../src/models/inbox/Message.js")).default;
  IntegrationEvent = (await import("../../src/models/IntegrationEvent.js"))
    .default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  ({
    WhatsappMediaService,
    WhatsappMediaPermanentError,
    WhatsappMediaTransientError,
  } = await import("../../src/services/whatsappMediaService.js"));
  WhatsappMessageSyncService = (
    await import("../../src/services/whatsappMessageSyncService.js")
  ).WhatsappMessageSyncService;
  ({ processWhatsappMessage } = await import(
    "../../src/queue/processors/whatsappMessageProcessor.js"
  ));

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
  uploadMock.mockReset();
  uploadMock.mockResolvedValue({
    success: true,
    key: "whatsapp/tenant/msg/media-id-abc.jpg",
    url: "https://bucket.s3.us-east-1.amazonaws.com/whatsapp/tenant/msg/media-id-abc.jpg",
    filename: "media-id-abc.jpg",
  });
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("WhatsappMediaService.downloadInboundMedia — happy path", () => {
  it("fetches Graph metadata, downloads bytes, uploads to S3, and updates the attachment", async () => {
    const { tenant, user } = await createTenantCtx("happy");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account, {
      providerMediaId: "media-id-1",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://media.fbcdn.net/signed-url",
          mime_type: "image/jpeg",
          file_size: 4096,
          sha256: "deadbeef",
        }),
      )
      .mockResolvedValueOnce(
        bytesResponse(Buffer.from("fake-jpeg-bytes"), { mime: "image/jpeg" }),
      );

    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: tenant._id,
      messageId: message._id,
      attachmentIndex: 0,
    });

    expect(result.storageKey).toBe(
      "whatsapp/tenant/msg/media-id-abc.jpg",
    );
    expect(result.sizeBytes).toBe(4096);
    expect(result.mimeType).toBe("image/jpeg");

    // Graph metadata + bytes calls
    const calls = fetchMock.mock.calls;
    expect(calls[0][0]).toContain("/v20.0/media-id-1");
    expect(calls[0][1].headers.Authorization).toBe("Bearer wa-token");
    expect(calls[1][0]).toBe("https://media.fbcdn.net/signed-url");
    expect(calls[1][1].headers.Authorization).toBe("Bearer wa-token");

    // S3 upload received the buffer + folder under the tenant + message
    const uploadCall = uploadMock.mock.calls[0];
    expect(uploadCall[0]).toBeInstanceOf(Buffer);
    expect(uploadCall[2]).toBe("image/jpeg");
    expect(uploadCall[3]).toBe(
      `whatsapp/${String(tenant._id)}/${String(message._id)}`,
    );

    const reloaded = await Message.findById(message._id);
    expect(reloaded.attachments[0].storageKey).toBe(
      "whatsapp/tenant/msg/media-id-abc.jpg",
    );
    expect(reloaded.attachments[0].sizeBytes).toBe(4096);
    expect(reloaded.attachments[0].mimeType).toBe("image/jpeg");
  });

  it("falls back to bytes content-length when Graph response lacks file_size", async () => {
    const { tenant, user } = await createTenantCtx("size-fallback");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account, {
      providerMediaId: "media-id-2",
      mimeType: "application/pdf",
      contentType: "document",
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://media.fbcdn.net/sig2",
          mime_type: "application/pdf",
        }),
      )
      .mockResolvedValueOnce(
        bytesResponse(Buffer.alloc(128), { mime: "application/pdf" }),
      );

    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: tenant._id,
      messageId: message._id,
    });
    expect(result.sizeBytes).toBe(128);
    expect(result.mimeType).toBe("application/pdf");
  });
});

describe("WhatsappMediaService.downloadInboundMedia — idempotency", () => {
  it("skips if storageKey is already populated", async () => {
    const { tenant, user } = await createTenantCtx("idem");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account);
    message.attachments[0].storageKey = "whatsapp/already/done.jpg";
    await message.save();

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already-downloaded");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("skips if attachment is missing", async () => {
    const { tenant, user } = await createTenantCtx("no-att");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account);
    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: tenant._id,
      messageId: message._id,
      attachmentIndex: 5,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("attachment-not-found");
  });

  it("skips on non-media content type", async () => {
    const { tenant, user } = await createTenantCtx("text-type");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account, {
      contentType: "text",
    });
    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: tenant._id,
      messageId: message._id,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("non-media-content-text");
  });
});

describe("WhatsappMediaService.downloadInboundMedia — failure handling", () => {
  it("classifies a 404 metadata fetch as permanent and marks the attachment failed", async () => {
    const { tenant, user } = await createTenantCtx("perm");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Media not found" } },
        { ok: false, status: 404 },
      ),
    );

    await expect(
      WhatsappMediaService.downloadInboundMedia({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaPermanentError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.attachments[0].storageKey).toBeFalsy();
    expect(reloaded.providerMeta?.whatsapp?.mediaDownload?.["0"]?.status).toBe(
      "failed",
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("classifies a 500 metadata fetch as transient and does NOT mark the attachment failed", async () => {
    const { tenant, user } = await createTenantCtx("transient");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Internal server error" } },
        { ok: false, status: 500 },
      ),
    );

    await expect(
      WhatsappMediaService.downloadInboundMedia({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaTransientError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.providerMeta?.whatsapp?.mediaDownload).toBeFalsy();
  });

  it("rejects when the channel account is disconnected (permanent)", async () => {
    const { tenant, user } = await createTenantCtx("disconnected");
    const account = await createWhatsappAccount(tenant, user, {
      status: "disconnected",
    });
    const { message } = await createInboundMediaMessage(tenant, account);

    await expect(
      WhatsappMediaService.downloadInboundMedia({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaPermanentError);
  });

  it("does not leak across tenants", async () => {
    const { tenant: t1, user: u1 } = await createTenantCtx("tenant-a");
    const { tenant: t2 } = await createTenantCtx("tenant-b");
    const account = await createWhatsappAccount(t1, u1);
    const { message } = await createInboundMediaMessage(t1, account);

    const result = await WhatsappMediaService.downloadInboundMedia({
      tenantId: t2._id,
      messageId: message._id,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("message-not-found");
  });
});

describe("WhatsappMessageSyncService — media download enqueue", () => {
  it("enqueues a download job after persisting an inbound image message", async () => {
    const { tenant, user } = await createTenantCtx("import");
    const account = await createWhatsappAccount(tenant, user);

    // REDIS_URL is unset so enqueue() returns null. We exercise the call
    // path through the sync service and then directly invoke the
    // processor to assert the routing contract on the next test.
    const result = await WhatsappMessageSyncService.importWhatsappMessage({
      tenantId: tenant._id,
      channelAccountId: account._id,
      payload: {
        message: {
          from: "15550002222",
          id: "wamid.image-1",
          timestamp: "1770000000",
          type: "image",
          image: {
            id: "media-id-img-1",
            mime_type: "image/jpeg",
          },
        },
        contact: { profile: { name: "Alice" }, wa_id: "15550002222" },
      },
    });

    expect(result.created).toBe(true);
    const stored = await Message.findById(result.message._id);
    expect(stored.contentType).toBe("image");
    expect(stored.attachments[0].providerMediaId).toBe("media-id-img-1");
    expect(stored.attachments[0].storageKey).toBeFalsy();
  });
});

describe("whatsappMessageProcessor — media routing", () => {
  it("routes whatsapp.media.download jobs through the media processor", async () => {
    const { tenant, user } = await createTenantCtx("route");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account, {
      providerMediaId: "media-id-route",
      mimeType: "image/jpeg",
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://media.fbcdn.net/route",
          mime_type: "image/jpeg",
          file_size: 64,
        }),
      )
      .mockResolvedValueOnce(
        bytesResponse(Buffer.alloc(64), { mime: "image/jpeg" }),
      );

    const out = await processWhatsappMessage({
      id: "wa-media-job-1",
      name: "whatsapp.media.download",
      data: {
        tenantId: String(tenant._id),
        messageId: String(message._id),
        attachmentIndex: 0,
        providerMediaId: "media-id-route",
      },
    });
    expect(out.storageKey).toBeTruthy();
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("converts permanent service errors into NonRetryableError", async () => {
    const { tenant, user } = await createTenantCtx("route-perm");
    const account = await createWhatsappAccount(tenant, user);
    const { message } = await createInboundMediaMessage(tenant, account);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Bad request" } },
        { ok: false, status: 400 },
      ),
    );

    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );

    await expect(
      processWhatsappMessage({
        id: "wa-media-job-2",
        name: "whatsapp.media.download",
        data: {
          tenantId: String(tenant._id),
          messageId: String(message._id),
          attachmentIndex: 0,
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("rejects jobs missing tenantId / messageId with NonRetryableError", async () => {
    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );
    await expect(
      processWhatsappMessage({
        id: "wa-media-job-3",
        name: "whatsapp.media.download",
        data: { messageId: "abc" },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    await expect(
      processWhatsappMessage({
        id: "wa-media-job-4",
        name: "whatsapp.media.download",
        data: { tenantId: "abc" },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
