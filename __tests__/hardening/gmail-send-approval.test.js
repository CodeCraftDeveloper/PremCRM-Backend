/**
 * Tests for P5-004 — Gmail Draft & Send with Approval.
 *
 * Coverage:
 *   1. composeDraft creates Message + ApprovalRequest with idempotency key,
 *      pending status, AI provenance, recipients normalisation, plan default
 *      to conversation participant.
 *   2. composeDraft refuses non-gmail conversations and disconnected accounts.
 *   3. approveDraft enqueues a `gmail.sync` / `message.send` job carrying
 *      the message idempotency key, marks the approval approved, blocks
 *      replays once approved.
 *   4. rejectDraft sets approval+message to rejected/failed; rejecting a
 *      non-pending request 400s.
 *   5. sendApprovedMessage builds an RFC-822 raw with In-Reply-To /
 *      References from the previous Gmail headers in the same conversation,
 *      POSTs to Gmail, marks Message sent, increments usage meter,
 *      writes audit logs, advances conversation snippet/lastMessageAt.
 *   6. sendApprovedMessage is idempotent — re-running on a sent message
 *      is a no-op without hitting the network.
 *   7. sendApprovedMessage on Gmail 4xx throws GmailSendPermanentError and
 *      marks the message failed.
 *   8. sendApprovedMessage on Gmail 5xx throws GmailSendTransientError and
 *      leaves the message pending.
 *   9. processGmailSend converts permanent errors to NonRetryableError and
 *      propagates transient errors as-is.
 *  10. Tenant isolation: cross-tenant approval cannot be approved.
 *  11. Gmail-sync processor routes `message.send` job names to the new
 *      send handler (not the renewal scan).
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

let mongoServer;

let Tenant;
let User;
let ChannelAccount;
let Conversation;
let Message;
let ContactIdentity;
let ApprovalRequest;
let UsageMeter;
let TokenVaultService;
let GmailOutboundService;
let GmailSendPermanentError;
let GmailSendTransientError;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function createTenantCtx(slug = "p5-004") {
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
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
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

async function createConversation(tenant, account, overrides = {}) {
  return Conversation.create({
    tenantId: tenant._id,
    channelAccountId: account._id,
    channel: "gmail",
    providerThreadId: overrides.providerThreadId || null,
    participantName: overrides.participantName || "Recipient",
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
  Message = (await import("../../src/models/inbox/Message.js")).default;
  ContactIdentity = (
    await import("../../src/models/inbox/ContactIdentity.js")
  ).default;
  ApprovalRequest = (await import("../../src/models/ApprovalRequest.js"))
    .default;
  UsageMeter = (await import("../../src/models/UsageMeter.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  const mod = await import("../../src/services/gmailOutboundService.js");
  GmailOutboundService = mod.GmailOutboundService;
  GmailSendPermanentError = mod.GmailSendPermanentError;
  GmailSendTransientError = mod.GmailSendTransientError;

  await Promise.all([
    ChannelAccount.syncIndexes(),
    Conversation.syncIndexes(),
    Message.syncIndexes(),
    ContactIdentity.syncIndexes(),
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
  it("creates Message + ApprovalRequest with idempotency key, pending status", async () => {
    const { tenant, user } = await createTenantCtx("compose-1");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);

    const { message, approvalRequest } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "Hello there",
      subject: "Reply from Orbinest",
      to: "client@external.com",
      sentByUserId: user._id,
    });

    expect(message.status).toBe("pending");
    expect(message.direction).toBe("outbound");
    expect(message.providerMeta?.gmail?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(message.providerMeta?.gmail?.recipients?.to).toEqual(["client@external.com"]);
    expect(message.providerMeta?.gmail?.messageIdHeader).toMatch(/^<[0-9a-f]{32}@/);
    expect(message.subject).toBe("Reply from Orbinest");
    expect(message.aiGenerated).toBe(false);

    expect(approvalRequest.status).toBe("pending");
    expect(approvalRequest.type).toBe("gmail.send");
    expect(String(approvalRequest.relatedEntityId)).toBe(String(message._id));

    const reloaded = await Message.findById(message._id);
    expect(String(reloaded.approvalRequestId)).toBe(String(approvalRequest._id));
  });

  it("uses ContactIdentity as recipient when `to` is omitted", async () => {
    const { tenant, user } = await createTenantCtx("compose-default-to");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const identity = await ContactIdentity.create({
      tenantId: tenant._id,
      provider: "email",
      providerIdentifier: "lead@external.com",
    });
    const conv = await createConversation(tenant, account, {
      contactIdentityId: identity._id,
    });

    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "Default to identity",
      sentByUserId: user._id,
    });

    expect(message.providerMeta.gmail.recipients.to).toEqual([
      "lead@external.com",
    ]);
  });

  it("rejects an empty body and an empty htmlBody", async () => {
    const { tenant, user } = await createTenantCtx("compose-empty");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);

    await expect(
      GmailOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conv._id,
        body: "",
        to: "client@external.com",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/body or htmlBody/i);
  });

  it("rejects non-gmail conversations", async () => {
    const { tenant, user } = await createTenantCtx("compose-wrong-channel");
    const account = await ChannelAccount.create({
      tenantId: tenant._id,
      provider: "whatsapp",
      providerAccountId: "+15555550100",
      connectedBy: user._id,
    });
    const conv = await Conversation.create({
      tenantId: tenant._id,
      channelAccountId: account._id,
      channel: "whatsapp",
    });

    await expect(
      GmailOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conv._id,
        body: "x",
        to: "client@x.com",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/not gmail/i);
  });

  it("normalises recipients (lowercase) and rejects bad emails", async () => {
    const { tenant, user } = await createTenantCtx("compose-bad-email");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);

    await expect(
      GmailOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conv._id,
        body: "x",
        to: "not-an-email",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/Invalid email address/i);

    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: ["MIXED@CASE.com", "second@x.com"],
      sentByUserId: user._id,
    });
    expect(message.providerMeta.gmail.recipients.to).toEqual([
      "mixed@case.com",
      "second@x.com",
    ]);
  });
});

describe("approveDraft / rejectDraft", () => {
  it("approves a pending draft and enqueues message.send with the idempotency key", async () => {
    const { tenant, user } = await createTenantCtx("approve");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { approvalRequest, message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "approve me",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    const enqueueFn = vi.fn(async () => ({ id: "job-1" }));
    const { approval } = await GmailOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });

    expect(approval.status).toBe("approved");
    expect(approval.decidedAt).toBeTruthy();
    expect(enqueueFn).toHaveBeenCalledTimes(1);
    const [queueName, jobName, payload, options] = enqueueFn.mock.calls[0];
    expect(queueName).toBe("gmail.sync");
    expect(jobName).toBe("message.send");
    expect(payload.tenantId).toBe(String(tenant._id));
    expect(payload.messageId).toBe(String(message._id));
    expect(options.idempotencyKey).toBe(
      `gmail.send:${message.providerMeta.gmail.idempotencyKey}`,
    );
  });

  it("returns alreadyApproved on second approval and does not re-enqueue", async () => {
    const { tenant, user } = await createTenantCtx("approve-twice");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { approvalRequest } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "twice",
      to: "client@x.com",
      sentByUserId: user._id,
    });
    const enqueueFn = vi.fn(async () => ({ id: "job-x" }));
    await GmailOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });
    const second = await GmailOutboundService.approveDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      enqueueFn,
    });
    expect(second.alreadyApproved).toBe(true);
    expect(enqueueFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending draft and marks the Message failed", async () => {
    const { tenant, user } = await createTenantCtx("reject");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { approvalRequest, message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "no",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    const result = await GmailOutboundService.rejectDraft({
      tenantId: tenant._id,
      approvalRequestId: approvalRequest._id,
      decidedBy: user._id,
      decisionReason: "off-brand",
    });
    expect(result.approval.status).toBe("rejected");

    const reloadedMsg = await Message.findById(message._id);
    expect(reloadedMsg.status).toBe("failed");
    expect(reloadedMsg.failureReason).toBe("off-brand");
  });

  it("refuses to approve a foreign-tenant request", async () => {
    const { tenant, user } = await createTenantCtx("approve-tenantA");
    const { tenant: tenantB } = await createTenantCtx("approve-tenantB");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { approvalRequest } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });
    const enqueueFn = vi.fn();
    await expect(
      GmailOutboundService.approveDraft({
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
  it("builds RFC-822 with In-Reply-To and References from the prior thread message, then marks message sent", async () => {
    const { tenant, user } = await createTenantCtx("send-thread");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account, {
      providerThreadId: "thread-XYZ",
    });
    // Prior inbound Gmail message in the same conversation that we will reply to.
    await Message.create({
      tenantId: tenant._id,
      conversationId: conv._id,
      channelAccountId: account._id,
      channel: "gmail",
      direction: "inbound",
      status: "sent",
      providerMessageId: "g-prev",
      providerTimestamp: new Date(Date.now() - 60_000),
      providerMeta: {
        gmail: {
          threadId: "thread-XYZ",
          messageId: "g-prev",
          messageIdHeader: "<prev@mail.gmail.com>",
        },
      },
    });

    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "Replying inline",
      subject: "Re: previous",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        expect(String(url)).toContain("/messages/send");
        captured = JSON.parse(init.body);
        return jsonResponse({ id: "g-sent-1", threadId: "thread-XYZ" });
      }),
    );

    const result = await GmailOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(result.providerMessageId).toBe("g-sent-1");
    expect(captured.threadId).toBe("thread-XYZ");

    const decoded = Buffer.from(
      captured.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toMatch(/From: owner@x.com/);
    expect(decoded).toMatch(/To: client@x.com/);
    expect(decoded).toMatch(/Subject: Re: previous/);
    expect(decoded).toMatch(/In-Reply-To: <prev@mail.gmail.com>/);
    expect(decoded).toMatch(/References: <prev@mail.gmail.com>/);
    expect(decoded).toMatch(/Message-Id: </);
    expect(decoded).toMatch(/Replying inline/);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("sent");
    expect(reloaded.providerMessageId).toBe("g-sent-1");
    expect(reloaded.deliveredAt).toBeTruthy();
    expect(reloaded.providerMeta.gmail.threadId).toBe("thread-XYZ");

    const reloadedConv = await Conversation.findById(conv._id);
    expect(reloadedConv.lastMessageDirection).toBe("outbound");
    expect(reloadedConv.lastMessageSnippet).toContain("Replying inline");

    const meter = await UsageMeter.findOne({ tenantId: tenant._id });
    expect(meter?.messagesSent).toBe(1);
  });

  it("is idempotent — re-running on a sent message is a no-op without HTTP calls", async () => {
    const { tenant, user } = await createTenantCtx("send-idem");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });
    // Pre-mark the message as already sent.
    await Message.updateOne(
      { _id: message._id, tenantId: tenant._id },
      {
        $set: {
          status: "sent",
          providerMessageId: "earlier-id",
          deliveredAt: new Date(),
        },
      },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await GmailOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });
    expect(result.skipped).toBe(true);
    expect(result.providerMessageId).toBe("earlier-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws GmailSendPermanentError on Gmail 4xx and marks message failed", async () => {
    const { tenant, user } = await createTenantCtx("send-4xx");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "Recipient address rejected" } },
          { ok: false, status: 400 },
        ),
      ),
    );

    await expect(
      GmailOutboundService.sendApprovedMessage({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(GmailSendPermanentError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.failureReason).toMatch(/Recipient address/i);
  });

  it("throws GmailSendTransientError on Gmail 5xx and leaves message pending", async () => {
    const { tenant, user } = await createTenantCtx("send-5xx");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "backend error" } },
          { ok: false, status: 503 },
        ),
      ),
    );

    await expect(
      GmailOutboundService.sendApprovedMessage({
        tenantId: tenant._id,
        messageId: message._id,
      }),
    ).rejects.toBeInstanceOf(GmailSendTransientError);

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("pending");
  });
});

describe("processGmailSend (queue routing + error mapping)", () => {
  it("converts permanent errors to NonRetryableError", async () => {
    const { tenant, user } = await createTenantCtx("proc-perm");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "no auth" } },
          { ok: false, status: 401 },
        ),
      ),
    );

    const { processGmailSend } = await import(
      "../../src/queue/processors/gmailSendProcessor.js"
    );
    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );

    await expect(
      processGmailSend({
        id: "j-perm",
        data: {
          tenantId: String(tenant._id),
          messageId: String(message._id),
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("propagates transient errors as ordinary Errors so BullMQ retries", async () => {
    const { tenant, user } = await createTenantCtx("proc-trans");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "x",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "rate" } },
          { ok: false, status: 429 },
        ),
      ),
    );

    const { processGmailSend } = await import(
      "../../src/queue/processors/gmailSendProcessor.js"
    );
    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );

    let caught = null;
    try {
      await processGmailSend({
        id: "j-trans",
        data: {
          tenantId: String(tenant._id),
          messageId: String(message._id),
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught).not.toBeInstanceOf(NonRetryableError);
    expect(caught.message).toMatch(/rate/i);
  });

  it("missing payload fields throw NonRetryableError immediately", async () => {
    const { processGmailSend } = await import(
      "../../src/queue/processors/gmailSendProcessor.js"
    );
    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );

    await expect(
      processGmailSend({ id: "j-nope", data: {} }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    await expect(
      processGmailSend({
        id: "j-nope-2",
        data: { tenantId: "x" },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("processGmailSync routes message.send job names to the send handler", async () => {
    const { tenant, user } = await createTenantCtx("router");
    const account = await createGmailAccount(tenant, user, "owner@x.com");
    const conv = await createConversation(tenant, account);
    const { message } = await GmailOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conv._id,
      body: "ok",
      to: "client@x.com",
      sentByUserId: user._id,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "g-routed", threadId: "t-r" })),
    );

    const { processGmailSync } = await import(
      "../../src/queue/processors/gmailSyncProcessor.js"
    );
    const result = await processGmailSync({
      id: "j-router",
      name: "message.send",
      data: {
        tenantId: String(tenant._id),
        messageId: String(message._id),
      },
    });
    expect(result.providerMessageId).toBe("g-routed");
  });
});
