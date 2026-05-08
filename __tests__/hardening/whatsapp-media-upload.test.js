/**
 * Tests for P6-004b — WhatsApp outbound media upload (multipart) and
 * the matching `composeMediaDraft` + send payload.
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

// Stub the S3 helpers BEFORE any module that imports them. The outbound
// media service uses uploadToS3 (for the tenant copy) and getFromS3
// (for re-using already-stored inbound assets).
const uploadToS3Mock = vi.fn();
const getFromS3Mock = vi.fn();
vi.mock("../../src/config/s3.js", () => ({
  uploadToS3: (...args) => uploadToS3Mock(...args),
  getFromS3: (...args) => getFromS3Mock(...args),
}));

let mongoServer;
let Tenant;
let User;
let ChannelAccount;
let Conversation;
let ContactIdentity;
let Message;
let ApprovalRequest;
let UsageMeter;
let TokenVaultService;
let WhatsappOutboundService;
let WhatsappOutboundMediaService;
let WhatsappMediaUploadPermanentError;
let WhatsappMediaUploadTransientError;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function createTenantCtx(slug = "p6-004b") {
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

async function createConversation(tenant, account, { withInbound = true } = {}) {
  const conversation = await Conversation.create({
    tenantId: tenant._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    providerThreadId: "+15550002222:987654321012345",
    participantName: "Alice",
    status: "open",
  });
  if (withInbound) {
    await Message.create({
      tenantId: tenant._id,
      conversationId: conversation._id,
      channelAccountId: account._id,
      channel: "whatsapp",
      direction: "inbound",
      status: "sent",
      contentType: "text",
      body: "Hello",
      providerMessageId: `wamid.in-${conversation._id}`,
      providerTimestamp: new Date(),
    });
  }
  return conversation;
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
  ApprovalRequest = (await import("../../src/models/ApprovalRequest.js")).default;
  UsageMeter = (await import("../../src/models/UsageMeter.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  WhatsappOutboundService = (
    await import("../../src/services/whatsappOutboundService.js")
  ).WhatsappOutboundService;
  ({
    WhatsappOutboundMediaService,
    WhatsappMediaUploadPermanentError,
    WhatsappMediaUploadTransientError,
  } = await import("../../src/services/whatsappOutboundMediaService.js"));

  await Promise.all([
    ChannelAccount.syncIndexes(),
    Conversation.syncIndexes(),
    ContactIdentity.syncIndexes(),
    Message.syncIndexes(),
    ApprovalRequest.syncIndexes(),
    UsageMeter.syncIndexes(),
  ]);
}, 30000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  vi.restoreAllMocks();
  uploadToS3Mock.mockReset();
  uploadToS3Mock.mockResolvedValue({
    success: true,
    key: "whatsapp/tenant/outbound/photo.jpg",
    url: "https://bucket.s3.us-east-1.amazonaws.com/whatsapp/tenant/outbound/photo.jpg",
    filename: "photo.jpg",
  });
  getFromS3Mock.mockReset();
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

// ──────────────────────────────────────────────────────────────────────
// uploadOutboundMedia
// ──────────────────────────────────────────────────────────────────────

describe("WhatsappOutboundMediaService.uploadOutboundMedia — happy path", () => {
  it("posts multipart to /{phone-number-id}/media and returns a Meta media id", async () => {
    const { tenant, user } = await createTenantCtx("up-happy");
    const account = await createWhatsappAccount(tenant, user);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "wa-media-up-1" }));

    const result = await WhatsappOutboundMediaService.uploadOutboundMedia({
      tenantId: tenant._id,
      channelAccountId: account._id,
      mediaType: "image",
      source: {
        kind: "buffer",
        buffer: Buffer.from("fake-jpeg-bytes"),
        mimeType: "image/jpeg",
        filename: "photo.jpg",
      },
    });

    expect(result.providerMediaId).toBe("wa-media-up-1");
    expect(result.mediaType).toBe("image");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("photo.jpg");
    expect(result.sizeBytes).toBe("fake-jpeg-bytes".length);
    // Outbound copy persisted to S3 because no `storageKey` was supplied
    expect(result.storageKey).toBe("whatsapp/tenant/outbound/photo.jpg");

    // Posted to the right Graph URL with bearer auth
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/v20.0/${encodeURIComponent("987654321012345")}/media`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer wa-token");
    // Body must be undici FormData (not a JSON string)
    expect(typeof init.body).not.toBe("string");
    expect(init.body).toBeInstanceOf(FormData);
    // FormData carries messaging_product, type, and the binary file
    expect(init.body.get("messaging_product")).toBe("whatsapp");
    expect(init.body.get("type")).toBe("image/jpeg");
    expect(init.body.get("file")).toBeInstanceOf(File);

    // Tenant-owned S3 copy was written under the outbound prefix
    const s3Call = uploadToS3Mock.mock.calls[0];
    expect(s3Call[3]).toBe(`whatsapp/${String(tenant._id)}/outbound`);
  });

  it("re-attaches an already-stored inbound asset via storageKey without writing a new S3 copy", async () => {
    const { tenant, user } = await createTenantCtx("up-s3");
    const account = await createWhatsappAccount(tenant, user);

    getFromS3Mock.mockResolvedValueOnce({
      buffer: Buffer.from("inbound-bytes"),
      contentType: "image/png",
      contentLength: 14,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ id: "wa-media-up-reuse" }),
    );

    const result = await WhatsappOutboundMediaService.uploadOutboundMedia({
      tenantId: tenant._id,
      channelAccountId: account._id,
      mediaType: "image",
      source: {
        kind: "s3",
        storageKey: "whatsapp/tenant/inbound/abc.png",
      },
    });

    expect(result.providerMediaId).toBe("wa-media-up-reuse");
    expect(result.storageKey).toBe("whatsapp/tenant/inbound/abc.png");
    // The S3 round-trip used getFromS3 ONCE; uploadToS3 must NOT have
    // been called because the asset already lives in the inbound prefix.
    expect(getFromS3Mock).toHaveBeenCalledTimes(1);
    expect(uploadToS3Mock).not.toHaveBeenCalled();
  });
});

describe("WhatsappOutboundMediaService.uploadOutboundMedia — validation", () => {
  it("rejects unsupported media types", async () => {
    const { tenant, user } = await createTenantCtx("up-bad-type");
    const account = await createWhatsappAccount(tenant, user);
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "sticker",
        source: {
          kind: "buffer",
          buffer: Buffer.from("x"),
          mimeType: "image/jpeg",
          filename: "x.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadPermanentError);
  });

  it("rejects mismatched MIME types", async () => {
    const { tenant, user } = await createTenantCtx("up-bad-mime");
    const account = await createWhatsappAccount(tenant, user);
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "buffer",
          buffer: Buffer.from("x"),
          mimeType: "application/pdf",
          filename: "x.pdf",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadPermanentError);
  });

  it("rejects empty buffers", async () => {
    const { tenant, user } = await createTenantCtx("up-empty");
    const account = await createWhatsappAccount(tenant, user);
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "buffer",
          buffer: Buffer.alloc(0),
          mimeType: "image/jpeg",
          filename: "empty.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadPermanentError);
  });

  it("rejects when channel account is disconnected (permanent)", async () => {
    const { tenant, user } = await createTenantCtx("up-disconnected");
    const account = await createWhatsappAccount(tenant, user, {
      status: "disconnected",
    });
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "buffer",
          buffer: Buffer.from("x"),
          mimeType: "image/jpeg",
          filename: "x.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadPermanentError);
  });
});

describe("WhatsappOutboundMediaService.uploadOutboundMedia — failure handling", () => {
  it("classifies Graph 4xx as permanent", async () => {
    const { tenant, user } = await createTenantCtx("up-perm");
    const account = await createWhatsappAccount(tenant, user);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Bad media" } },
        { ok: false, status: 400 },
      ),
    );
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "buffer",
          buffer: Buffer.from("x"),
          mimeType: "image/jpeg",
          filename: "x.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadPermanentError);
    // No S3 copy persisted on failure
    expect(uploadToS3Mock).not.toHaveBeenCalled();
  });

  it("classifies Graph 5xx as transient", async () => {
    const { tenant, user } = await createTenantCtx("up-transient");
    const account = await createWhatsappAccount(tenant, user);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        { error: { message: "Service unavailable" } },
        { ok: false, status: 503 },
      ),
    );
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "buffer",
          buffer: Buffer.from("x"),
          mimeType: "image/jpeg",
          filename: "x.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadTransientError);
  });

  it("wraps S3 read failures (s3 source) as transient", async () => {
    const { tenant, user } = await createTenantCtx("up-s3-fail");
    const account = await createWhatsappAccount(tenant, user);
    getFromS3Mock.mockRejectedValueOnce(new Error("S3 down"));
    await expect(
      WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: tenant._id,
        channelAccountId: account._id,
        mediaType: "image",
        source: {
          kind: "s3",
          storageKey: "whatsapp/tenant/inbound/x.jpg",
          mimeType: "image/jpeg",
        },
      }),
    ).rejects.toBeInstanceOf(WhatsappMediaUploadTransientError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// composeMediaDraft
// ──────────────────────────────────────────────────────────────────────

describe("WhatsappOutboundService.composeMediaDraft", () => {
  it("creates a pending media Message + ApprovalRequest with the right contentType + attachment", async () => {
    const { tenant, user } = await createTenantCtx("compose-media");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "image",
        providerMediaId: "wa-media-up-1",
        mimeType: "image/jpeg",
        filename: "photo.jpg",
        sizeBytes: 1234,
        storageKey: "whatsapp/tenant/outbound/photo.jpg",
        caption: "Look at this",
        to: "+15550002222",
        sentByUserId: user._id,
      });

    expect(message.contentType).toBe("image");
    expect(message.status).toBe("pending");
    expect(message.body).toBe("Look at this");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].providerMediaId).toBe("wa-media-up-1");
    expect(message.attachments[0].storageKey).toBe(
      "whatsapp/tenant/outbound/photo.jpg",
    );
    expect(message.providerMeta.whatsapp.type).toBe("image");
    expect(message.providerMeta.whatsapp.media.providerMediaId).toBe(
      "wa-media-up-1",
    );
    expect(message.providerMeta.whatsapp.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(approvalRequest.type).toBe("whatsapp.send");
    expect(approvalRequest.status).toBe("pending");
    expect(approvalRequest.metadata.media.mediaType).toBe("image");

    const reloaded = await Message.findById(message._id);
    expect(String(reloaded.approvalRequestId)).toBe(String(approvalRequest._id));
  });

  it("blocks media drafts when the 24-hour customer-service window is closed", async () => {
    const { tenant, user } = await createTenantCtx("compose-media-closed");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });

    await expect(
      WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "image",
        providerMediaId: "wa-media-up-x",
        mimeType: "image/jpeg",
        filename: "x.jpg",
        caption: "",
        to: "+15550002222",
        sentByUserId: user._id,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/24-hour/i),
    });
  });

  it("rejects unsupported mediaTypes and missing providerMediaId", async () => {
    const { tenant, user } = await createTenantCtx("compose-media-bad");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    await expect(
      WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "sticker",
        providerMediaId: "x",
        mimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "image",
        providerMediaId: "",
        mimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ──────────────────────────────────────────────────────────────────────
// sendApprovedMessage — Cloud API media payload
// ──────────────────────────────────────────────────────────────────────

describe("WhatsappOutboundService.sendApprovedMessage — media payloads", () => {
  it("posts type:image with id + caption when sending an approved image draft", async () => {
    const { tenant, user } = await createTenantCtx("send-image");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "image",
        providerMediaId: "wa-media-img-1",
        mimeType: "image/jpeg",
        filename: "photo.jpg",
        caption: "Hello world",
        to: "+15550002222",
        sentByUserId: user._id,
      });

    const enqueueMock = vi.fn().mockResolvedValue({ id: "job-1" });
    await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn: enqueueMock,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: "wamid.sent-1" }] }),
      );

    const result = await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });
    expect(result.providerMessageId).toBe("wamid.sent-1");

    const [, init] = fetchMock.mock.calls[0];
    const sentPayload = JSON.parse(init.body);
    expect(sentPayload.type).toBe("image");
    expect(sentPayload.image).toEqual({
      id: "wa-media-img-1",
      caption: "Hello world",
    });

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("sent");
    expect(reloaded.providerMessageId).toBe("wamid.sent-1");
  });

  it("posts type:document with id + caption + filename for documents", async () => {
    const { tenant, user } = await createTenantCtx("send-doc");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "document",
        providerMediaId: "wa-media-doc-1",
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        caption: "April invoice",
        to: "+15550002222",
        sentByUserId: user._id,
      });

    const enqueueMock = vi.fn().mockResolvedValue({ id: "job-2" });
    await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn: enqueueMock,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: "wamid.sent-doc-1" }] }),
      );

    await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    const [, init] = fetchMock.mock.calls[0];
    const sentPayload = JSON.parse(init.body);
    expect(sentPayload.type).toBe("document");
    expect(sentPayload.document).toEqual({
      id: "wa-media-doc-1",
      caption: "April invoice",
      filename: "invoice.pdf",
    });
  });

  it("posts type:audio with id only (no caption/filename keys) for audio", async () => {
    const { tenant, user } = await createTenantCtx("send-audio");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeMediaDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: account._id,
        mediaType: "audio",
        providerMediaId: "wa-media-aud-1",
        mimeType: "audio/mpeg",
        filename: "voice.mp3",
        caption: "ignored on audio",
        to: "+15550002222",
        sentByUserId: user._id,
      });

    const enqueueMock = vi.fn().mockResolvedValue({ id: "job-3" });
    await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn: enqueueMock,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: "wamid.sent-aud-1" }] }),
      );

    await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    const [, init] = fetchMock.mock.calls[0];
    const sentPayload = JSON.parse(init.body);
    expect(sentPayload.type).toBe("audio");
    expect(sentPayload.audio).toEqual({ id: "wa-media-aud-1" });
    expect(sentPayload.audio.caption).toBeUndefined();
    expect(sentPayload.audio.filename).toBeUndefined();
  });
});
