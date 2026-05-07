/**
 * Tests for P6-002 - WhatsApp outbound draft/send with approval.
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
let WhatsappSendPermanentError;
let WhatsappSendTransientError;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function createTenantCtx(slug = "p6-002") {
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

async function createWhatsappConversation(tenant, account, overrides = {}) {
  return Conversation.create({
    tenantId: tenant._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    providerThreadId: "+15550002222:987654321012345",
    participantName: "Alice Customer",
    status: "open",
    ...overrides,
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js"))
    .default;
  Conversation = (await import("../../src/models/inbox/Conversation.js"))
    .default;
  ContactIdentity = (
    await import("../../src/models/inbox/ContactIdentity.js")
  ).default;
  Message = (await import("../../src/models/inbox/Message.js")).default;
  ApprovalRequest = (await import("../../src/models/ApprovalRequest.js"))
    .default;
  UsageMeter = (await import("../../src/models/UsageMeter.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  const mod = await import("../../src/services/whatsappOutboundService.js");
  WhatsappOutboundService = mod.WhatsappOutboundService;
  WhatsappSendPermanentError = mod.WhatsappSendPermanentError;
  WhatsappSendTransientError = mod.WhatsappSendTransientError;

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
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("composeDraft", () => {
  it("creates a pending WhatsApp Message and matching ApprovalRequest", async () => {
    const { tenant, user } = await createTenantCtx("compose");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: "Hello on WhatsApp",
        to: "+1 (555) 000-2222",
        sentByUserId: user._id,
      });

    expect(message.channel).toBe("whatsapp");
    expect(message.status).toBe("pending");
    expect(message.direction).toBe("outbound");
    expect(message.providerMeta.whatsapp.recipient).toBe("+15550002222");
    expect(message.providerMeta.whatsapp.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(approvalRequest.type).toBe("whatsapp.send");
    expect(approvalRequest.status).toBe("pending");
    expect(String(approvalRequest.relatedEntityId)).toBe(String(message._id));

    const reloaded = await Message.findById(message._id);
    expect(String(reloaded.approvalRequestId)).toBe(String(approvalRequest._id));
  });

  it("uses the WhatsApp ContactIdentity recipient when `to` is omitted", async () => {
    const { tenant, user } = await createTenantCtx("identity-recipient");
    const account = await createWhatsappAccount(tenant, user);
    const identity = await ContactIdentity.create({
      tenantId: tenant._id,
      provider: "whatsapp",
      providerIdentifier: "+15550003333",
    });
    const conversation = await createWhatsappConversation(tenant, account, {
      contactIdentityId: identity._id,
      providerThreadId: null,
    });

    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Identity default",
      sentByUserId: user._id,
    });

    expect(message.providerMeta.whatsapp.recipient).toBe("+15550003333");
  });

  it("rejects empty body, non-whatsapp conversations, and disconnected accounts", async () => {
    const { tenant, user } = await createTenantCtx("compose-errors");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);

    await expect(
      WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: " ",
        to: "+15550002222",
      }),
    ).rejects.toThrow(/body is required/i);

    const gmailAccount = await ChannelAccount.create({
      tenantId: tenant._id,
      provider: "gmail",
      providerAccountId: "owner@example.com",
      connectedBy: user._id,
    });
    const gmailConversation = await Conversation.create({
      tenantId: tenant._id,
      channelAccountId: gmailAccount._id,
      channel: "gmail",
    });
    await expect(
      WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: gmailConversation._id,
        body: "Wrong channel",
        to: "+15550002222",
      }),
    ).rejects.toThrow(/not whatsapp/i);

    await ChannelAccount.updateOne(
      { _id: account._id },
      { $set: { status: "disconnected" } },
    );
    await expect(
      WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: "Disconnected",
        to: "+15550002222",
      }),
    ).rejects.toThrow(/not connected/i);
  });
});

describe("approveDraft / rejectDraft", () => {
  it("approves and enqueues whatsapp.message.send with the idempotency key", async () => {
    const { tenant, user } = await createTenantCtx("approve");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { approvalRequest, message } =
      await WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: "Approve me",
        sentByUserId: user._id,
      });

    const enqueueFn = vi.fn(async () => ({ id: "wa-job-1" }));
    const { approval } = await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });

    expect(approval.status).toBe("approved");
    expect(enqueueFn).toHaveBeenCalledTimes(1);
    const [queueName, jobName, payload, options] = enqueueFn.mock.calls[0];
    expect(queueName).toBe("whatsapp.messages");
    expect(jobName).toBe("whatsapp.message.send");
    expect(payload.tenantId).toBe(String(tenant._id));
    expect(payload.messageId).toBe(String(message._id));
    expect(options.idempotencyKey).toBe(
      `whatsapp.send:${message.providerMeta.whatsapp.idempotencyKey}`,
    );
  });

  it("does not enqueue a second time after approval", async () => {
    const { tenant, user } = await createTenantCtx("approve-twice");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { approvalRequest } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Approve twice",
      sentByUserId: user._id,
    });
    const enqueueFn = vi.fn(async () => ({ id: "wa-job" }));

    await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });
    const second = await WhatsappOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });

    expect(second.alreadyApproved).toBe(true);
    expect(enqueueFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending draft and marks the message failed", async () => {
    const { tenant, user } = await createTenantCtx("reject");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { approvalRequest, message } =
      await WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: "Reject me",
        sentByUserId: user._id,
      });

    const result = await WhatsappOutboundService.rejectDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      decisionReason: "Needs rewrite",
    });

    expect(result.approval.status).toBe("rejected");
    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.failureReason).toBe("Needs rewrite");
  });

  it("refuses cross-tenant approval", async () => {
    const { tenant, user } = await createTenantCtx("tenant-a");
    const { tenant: tenantB } = await createTenantCtx("tenant-b");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { approvalRequest } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Tenant scoped",
      sentByUserId: user._id,
    });

    const enqueueFn = vi.fn();
    await expect(
      WhatsappOutboundService.approveDraft({
        tenantId: tenantB._id,
        approvalRequestId: approvalRequest._id,
        decidedBy: user._id,
        enqueueFn,
      }),
    ).rejects.toThrow(/not found/i);
    expect(enqueueFn).not.toHaveBeenCalled();
  });
});

describe("sendApprovedMessage", () => {
  it("posts to Cloud API, marks the message sent, updates conversation and usage", async () => {
    const { tenant, user } = await createTenantCtx("send");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account, {
      firstReplyAt: null,
    });
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Sent through Cloud API",
      sentByUserId: user._id,
    });

    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        expect(String(url)).toContain("/v20.0/987654321012345/messages");
        captured = JSON.parse(init.body);
        expect(init.headers.Authorization).toBe("Bearer wa-token");
        return jsonResponse({
          messaging_product: "whatsapp",
          contacts: [{ input: "15550002222", wa_id: "15550002222" }],
          messages: [{ id: "wamid.outbound-1" }],
        });
      }),
    );

    const result = await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(result.providerMessageId).toBe("wamid.outbound-1");
    expect(captured).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550002222",
      type: "text",
      text: { preview_url: false, body: "Sent through Cloud API" },
    });

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("sent");
    expect(reloaded.providerMessageId).toBe("wamid.outbound-1");
    expect(reloaded.deliveredAt).toBeTruthy();

    const reloadedConversation = await Conversation.findById(conversation._id);
    expect(reloadedConversation.lastMessageDirection).toBe("outbound");
    expect(reloadedConversation.lastMessageSnippet).toBe("Sent through Cloud API");
    expect(reloadedConversation.firstReplyAt).toBeTruthy();

    const meter = await UsageMeter.findOne({ tenantId: tenant._id });
    expect(meter?.messagesSent).toBe(1);
  });

  it("is idempotent when rerun on an already sent message", async () => {
    const { tenant, user } = await createTenantCtx("send-idempotent");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Already sent",
      sentByUserId: user._id,
    });
    await Message.updateOne(
      { _id: message._id },
      { $set: { status: "sent", providerMessageId: "wamid.prior" } },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(result.skipped).toBe(true);
    expect(result.providerMessageId).toBe("wamid.prior");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Cloud API 4xx to permanent failure and marks message failed", async () => {
    const { tenant, user } = await createTenantCtx("send-4xx");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Bad recipient",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "Unsupported post request" } },
          { ok: false, status: 400 },
        ),
      ),
    );

    await expect(
      WhatsappOutboundService.sendApprovedMessage({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(WhatsappSendPermanentError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.failureReason).toMatch(/Unsupported post request/i);
  });

  it("maps Cloud API 429/5xx to transient failure and leaves message pending", async () => {
    const { tenant, user } = await createTenantCtx("send-429");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Retry later",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "Rate limit" } },
          { ok: false, status: 429 },
        ),
      ),
    );

    await expect(
      WhatsappOutboundService.sendApprovedMessage({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(WhatsappSendTransientError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("pending");
  });
});

describe("queue processor", () => {
  it("routes whatsapp.message.send jobs to the outbound sender", async () => {
    const { tenant, user } = await createTenantCtx("processor-send");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Processor route",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ messages: [{ id: "wamid.processor-outbound" }] }),
      ),
    );

    const { processWhatsappMessage } = await import(
      "../../src/queue/processors/whatsappMessageProcessor.js"
    );
    const result = await processWhatsappMessage({
      id: "wa-send-job",
      name: "whatsapp.message.send",
      data: {
        tenantId: String(tenant._id),
        messageId: String(message._id),
      },
    });

    expect(result.providerMessageId).toBe("wamid.processor-outbound");
  });

  it("converts permanent send errors to NonRetryableError", async () => {
    const { tenant, user } = await createTenantCtx("processor-perm");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createWhatsappConversation(tenant, account);
    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Processor permanent",
      sentByUserId: user._id,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "No permission" } },
          { ok: false, status: 403 },
        ),
      ),
    );

    const { processWhatsappMessage } = await import(
      "../../src/queue/processors/whatsappMessageProcessor.js"
    );
    const { NonRetryableError } = await import("../../src/queue/errors.js");

    await expect(
      processWhatsappMessage({
        id: "wa-perm-job",
        name: "whatsapp.message.send",
        data: {
          tenantId: String(tenant._id),
          messageId: String(message._id),
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
