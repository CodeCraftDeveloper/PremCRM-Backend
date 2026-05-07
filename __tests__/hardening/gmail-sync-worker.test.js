/**
 * Tests for P5-003 — Gmail Sync Worker (history list + message import).
 *
 * Coverage:
 *   1. parseAddress / parseAddressList header helpers.
 *   2. importGmailMessage normalises a Gmail message into a
 *      Conversation + Message + ContactIdentity, advances counters.
 *   3. Re-running the import for the same Gmail message ID is idempotent.
 *   4. Inbound vs outbound direction detection.
 *   5. syncFromHistoryId paginates history.list, imports new messages,
 *      and advances ChannelAccount.syncCursor to the latest historyId.
 *   6. syncFromHistoryId without a syncCursor falls through to bootstrap.
 *   7. syncFromHistoryId on Gmail 404 (history expired) bootstraps.
 *   8. processInboundWebhook routes gmail events to GmailSyncService and
 *      marks the IntegrationEvent processed.
 *   9. processInboundWebhook on a gmail event without a channelAccountId
 *      throws NonRetryableError.
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
let IntegrationEvent;
let TokenVaultService;
let GmailSyncService;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const oid = () => new mongoose.Types.ObjectId();

async function createTenantCtx(slug = "p5-003") {
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

async function createGmailAccount(
  tenant,
  user,
  providerAccountId,
  overrides = {},
) {
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
  IntegrationEvent = (await import("../../src/models/IntegrationEvent.js"))
    .default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  GmailSyncService = await import("../../src/services/gmailSyncService.js");

  await Promise.all([
    ChannelAccount.syncIndexes(),
    Conversation.syncIndexes(),
    Message.syncIndexes(),
    ContactIdentity.syncIndexes(),
    IntegrationEvent.syncIndexes(),
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

describe("address parsing helpers", () => {
  it("parses 'Name <email@x.com>' correctly", () => {
    const parsed = GmailSyncService.parseAddress('"Alice Doe" <alice@x.com>');
    expect(parsed).toEqual({ email: "alice@x.com", name: "Alice Doe" });
  });

  it("parses raw email", () => {
    const parsed = GmailSyncService.parseAddress("bob@example.com");
    expect(parsed).toEqual({ email: "bob@example.com", name: null });
  });

  it("returns null for nonsense", () => {
    expect(GmailSyncService.parseAddress("")).toBeNull();
    expect(GmailSyncService.parseAddress("not-an-email")).toBeNull();
  });

  it("parses comma-separated address lists", () => {
    const list = GmailSyncService.parseAddressList(
      '"A" <a@x.com>, b@x.com, "C" <c@x.com>',
    );
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({ email: "a@x.com", name: "A" });
    expect(list[1]).toEqual({ email: "b@x.com", name: null });
  });

  it("lowercases email addresses", () => {
    const parsed = GmailSyncService.parseAddress("Mixed.Case@X.COM");
    expect(parsed.email).toBe("mixed.case@x.com");
  });
});

function buildGmailMessage({
  id,
  threadId,
  from,
  to,
  subject,
  internalDateMs = Date.now(),
  labelIds = ["INBOX", "UNREAD"],
  snippet = "Hello there",
} = {}) {
  return {
    id,
    threadId: threadId || id,
    internalDate: String(internalDateMs),
    snippet,
    labelIds,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: subject },
        { name: "Date", value: new Date(internalDateMs).toUTCString() },
        { name: "Message-Id", value: `<${id}@mail.gmail.com>` },
      ],
    },
  };
}

describe("importGmailMessage", () => {
  it("creates Conversation, Message, and ContactIdentity for an inbound email", async () => {
    const { tenant, user } = await createTenantCtx("import-inbound");
    const account = await createGmailAccount(tenant, user, "owner@example.com");

    const detail = buildGmailMessage({
      id: "g1",
      threadId: "t1",
      from: '"Sender Sam" <sam@external.com>',
      to: "owner@example.com",
      subject: "Welcome to Acme",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        expect(String(url)).toContain("/messages/g1");
        return jsonResponse(detail);
      }),
    );

    const result = await GmailSyncService.importGmailMessage({
      tenantId: tenant._id,
      channelAccount: account,
      accessToken: "access-token-fresh",
      gmailMessageId: "g1",
    });

    expect(result.created).toBe(true);
    expect(result.direction).toBe("inbound");

    const messages = await Message.find({ tenantId: tenant._id });
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("Welcome to Acme");
    expect(messages[0].providerMessageId).toBe("g1");
    expect(messages[0].senderIdentifier).toBe("sam@external.com");
    expect(messages[0].providerMeta?.gmail?.threadId).toBe("t1");

    const conversations = await Conversation.find({ tenantId: tenant._id });
    expect(conversations).toHaveLength(1);
    expect(conversations[0].providerThreadId).toBe("t1");
    expect(conversations[0].messageCount).toBe(1);
    expect(conversations[0].unreadCount).toBe(1);
    expect(conversations[0].lastMessageDirection).toBe("inbound");

    const identities = await ContactIdentity.find({ tenantId: tenant._id });
    expect(identities).toHaveLength(1);
    expect(identities[0].providerIdentifier).toBe("sam@external.com");
    expect(identities[0].displayName).toBe("Sender Sam");
  });

  it("is idempotent on the Gmail message ID (re-run is a no-op)", async () => {
    const { tenant, user } = await createTenantCtx("import-dup");
    const account = await createGmailAccount(tenant, user, "owner@x.com");

    const detail = buildGmailMessage({
      id: "g2",
      threadId: "t2",
      from: "ext@x.com",
      to: "owner@x.com",
      subject: "Hi",
    });

    const fetchMock = vi.fn(async () => jsonResponse(detail));
    vi.stubGlobal("fetch", fetchMock);

    const first = await GmailSyncService.importGmailMessage({
      tenantId: tenant._id,
      channelAccount: account,
      accessToken: "t",
      gmailMessageId: "g2",
    });
    const second = await GmailSyncService.importGmailMessage({
      tenantId: tenant._id,
      channelAccount: account,
      accessToken: "t",
      gmailMessageId: "g2",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const messages = await Message.find({ tenantId: tenant._id });
    expect(messages).toHaveLength(1);
    const conversations = await Conversation.find({ tenantId: tenant._id });
    expect(conversations).toHaveLength(1);
    expect(conversations[0].messageCount).toBe(1);
  });

  it("classifies a message FROM the account as outbound", async () => {
    const { tenant, user } = await createTenantCtx("import-out");
    const account = await createGmailAccount(tenant, user, "me@x.com");

    const detail = buildGmailMessage({
      id: "g3",
      threadId: "t3",
      from: '"Me" <me@x.com>',
      to: "client@y.com",
      subject: "Following up",
      labelIds: ["SENT"],
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detail)));

    const result = await GmailSyncService.importGmailMessage({
      tenantId: tenant._id,
      channelAccount: account,
      accessToken: "t",
      gmailMessageId: "g3",
    });

    expect(result.direction).toBe("outbound");
    const conversations = await Conversation.find({ tenantId: tenant._id });
    expect(conversations[0].lastMessageDirection).toBe("outbound");
    expect(conversations[0].unreadCount).toBe(0);
    // Outbound counterpart is the To: address.
    const identities = await ContactIdentity.find({ tenantId: tenant._id });
    expect(identities[0].providerIdentifier).toBe("client@y.com");
  });

  it("returns null when Gmail 404s on messages.get", async () => {
    const { tenant, user } = await createTenantCtx("import-404");
    const account = await createGmailAccount(tenant, user, "owner@x.com");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "not found" } }, {
          ok: false,
          status: 404,
        }),
      ),
    );

    const result = await GmailSyncService.importGmailMessage({
      tenantId: tenant._id,
      channelAccount: account,
      accessToken: "t",
      gmailMessageId: "g-missing",
    });
    expect(result).toBeNull();
    const messages = await Message.find({ tenantId: tenant._id });
    expect(messages).toHaveLength(0);
  });
});

describe("syncFromHistoryId", () => {
  it("paginates history.list, imports new messages, and advances syncCursor", async () => {
    const { tenant, user } = await createTenantCtx("history-walk");
    const account = await createGmailAccount(tenant, user, "owner@x.com", {
      syncCursor: "100",
    });

    const messageDetails = {
      m1: buildGmailMessage({
        id: "m1",
        threadId: "thread-A",
        from: "alice@x.com",
        to: "owner@x.com",
        subject: "First",
      }),
      m2: buildGmailMessage({
        id: "m2",
        threadId: "thread-A",
        from: "alice@x.com",
        to: "owner@x.com",
        subject: "Second",
      }),
      m3: buildGmailMessage({
        id: "m3",
        threadId: "thread-B",
        from: "bob@x.com",
        to: "owner@x.com",
        subject: "Hello",
      }),
    };

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/history?")) {
        if (u.includes("pageToken=PAGE2")) {
          return jsonResponse({
            historyId: "150",
            history: [
              {
                id: "150",
                messagesAdded: [{ message: { id: "m3" } }],
              },
            ],
          });
        }
        return jsonResponse({
          historyId: "140",
          nextPageToken: "PAGE2",
          history: [
            {
              id: "120",
              messagesAdded: [{ message: { id: "m1" } }],
            },
            {
              id: "140",
              messagesAdded: [
                { message: { id: "m2" } },
                { message: { id: "m1" } }, // duplicate within same response
              ],
            },
          ],
        });
      }
      const match = u.match(/\/messages\/([^?]+)/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        return jsonResponse(messageDetails[id]);
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await GmailSyncService.syncFromHistoryId({
      tenantId: tenant._id,
      channelAccountId: account._id,
    });

    expect(summary.synced).toBe(true);
    expect(summary.scanned).toBe(3); // m1, m2, m3 — duplicate collapsed
    expect(summary.imported).toBe(3);
    expect(summary.cursor).toBe("150");

    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.syncCursor).toBe("150");
    expect(reloaded.consecutiveErrors).toBe(0);
    expect(reloaded.lastSyncAt).toBeTruthy();

    const messages = await Message.find({ tenantId: tenant._id });
    expect(messages).toHaveLength(3);
    const conversations = await Conversation.find({ tenantId: tenant._id });
    expect(conversations).toHaveLength(2); // thread-A + thread-B
    const threadA = conversations.find((c) => c.providerThreadId === "thread-A");
    expect(threadA.messageCount).toBe(2);
  });

  it("falls through to bootstrap when ChannelAccount has no syncCursor", async () => {
    const { tenant, user } = await createTenantCtx("history-no-cursor");
    const account = await createGmailAccount(tenant, user, "owner@x.com");

    const detail = buildGmailMessage({
      id: "boot-1",
      threadId: "thread-boot",
      from: "x@x.com",
      to: "owner@x.com",
      subject: "Bootstrap",
    });

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/messages/boot-1")) return jsonResponse(detail);
      if (u.includes("/messages?")) {
        return jsonResponse({ messages: [{ id: "boot-1" }] });
      }
      if (u.includes("/profile")) {
        return jsonResponse({ historyId: "999" });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await GmailSyncService.syncFromHistoryId({
      tenantId: tenant._id,
      channelAccountId: account._id,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.cursor).toBe("999");

    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.syncCursor).toBe("999");
  });

  it("bootstraps when Gmail 404s on history.list (history expired)", async () => {
    const { tenant, user } = await createTenantCtx("history-expired");
    const account = await createGmailAccount(tenant, user, "owner@x.com", {
      syncCursor: "1",
    });

    const detail = buildGmailMessage({
      id: "after-expire",
      threadId: "t",
      from: "x@x.com",
      to: "owner@x.com",
      subject: "post-bootstrap",
    });

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/history?")) {
        return jsonResponse(
          { error: { message: "history not found" } },
          { ok: false, status: 404 },
        );
      }
      if (u.includes("/messages/after-expire")) return jsonResponse(detail);
      if (u.includes("/messages?")) {
        return jsonResponse({ messages: [{ id: "after-expire" }] });
      }
      if (u.includes("/profile")) return jsonResponse({ historyId: "777" });
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await GmailSyncService.syncFromHistoryId({
      tenantId: tenant._id,
      channelAccountId: account._id,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.cursor).toBe("777");
    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.syncCursor).toBe("777");
  });

  it("returns gracefully when the channel account does not exist", async () => {
    const result = await GmailSyncService.syncFromHistoryId({
      tenantId: oid(),
      channelAccountId: oid(),
    });
    expect(result.synced).toBe(false);
    expect(result.reason).toBe("channel-account-not-found");
  });

  it("increments consecutiveErrors and rethrows on a non-404 Gmail failure", async () => {
    const { tenant, user } = await createTenantCtx("history-err");
    const account = await createGmailAccount(tenant, user, "owner@x.com", {
      syncCursor: "5",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "rate limited" } }, {
          ok: false,
          status: 429,
        }),
      ),
    );

    await expect(
      GmailSyncService.syncFromHistoryId({
        tenantId: tenant._id,
        channelAccountId: account._id,
      }),
    ).rejects.toThrow(/rate limited/i);

    const reloaded = await ChannelAccount.findById(account._id);
    expect(reloaded.consecutiveErrors).toBe(1);
    expect(reloaded.lastError).toMatch(/rate limited/i);
    // Cursor should NOT have advanced.
    expect(reloaded.syncCursor).toBe("5");
  });
});

describe("processInboundWebhook (P5-003 routing)", () => {
  it("runs Gmail sync for gmail events and marks the IntegrationEvent processed", async () => {
    const { tenant, user } = await createTenantCtx("proc-gmail");
    const account = await createGmailAccount(tenant, user, "owner@x.com", {
      syncCursor: "100",
    });

    const event = await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "gmail",
      eventType: "gmail.history",
      externalEventId: "msg-proc-1",
      channelAccountId: account._id,
      status: "received",
    });

    const detail = buildGmailMessage({
      id: "proc-1",
      threadId: "t",
      from: "x@x.com",
      to: "owner@x.com",
      subject: "Procd",
    });

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/history?")) {
        return jsonResponse({
          historyId: "200",
          history: [
            { id: "200", messagesAdded: [{ message: { id: "proc-1" } }] },
          ],
        });
      }
      if (u.includes("/messages/proc-1")) return jsonResponse(detail);
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );

    const result = await processInboundWebhook({
      id: "job-1",
      data: {
        tenantId: String(tenant._id),
        provider: "gmail",
        integrationEventId: String(event._id),
        channelAccountId: String(account._id),
      },
    });

    expect(result.eventId).toBe(String(event._id));
    expect(result.imported).toBe(1);
    expect(result.cursor).toBe("200");

    const reloadedEvent = await IntegrationEvent.findById(event._id);
    expect(reloadedEvent.status).toBe("processed");
    expect(reloadedEvent.processedAt).toBeTruthy();

    const messages = await Message.find({ tenantId: tenant._id });
    expect(messages).toHaveLength(1);
    expect(messages[0].providerMessageId).toBe("proc-1");

    const reloadedAccount = await ChannelAccount.findById(account._id);
    expect(reloadedAccount.syncCursor).toBe("200");
  });

  it("throws NonRetryableError when a gmail event has no channelAccountId", async () => {
    const { tenant } = await createTenantCtx("proc-no-acct");

    const event = await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "gmail",
      eventType: "gmail.history",
      externalEventId: "msg-no-acct",
      status: "received",
    });

    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );
    const { NonRetryableError } = await import(
      "../../src/queue/errors.js"
    );

    await expect(
      processInboundWebhook({
        id: "job-x",
        data: {
          tenantId: String(tenant._id),
          provider: "gmail",
          integrationEventId: String(event._id),
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("returns skipped when the event is already processed", async () => {
    const { tenant, user } = await createTenantCtx("proc-skip");
    const account = await createGmailAccount(tenant, user, "owner@x.com");

    const event = await IntegrationEvent.create({
      tenantId: tenant._id,
      provider: "gmail",
      eventType: "gmail.history",
      externalEventId: "msg-already",
      channelAccountId: account._id,
      status: "processed",
      processedAt: new Date(),
    });

    const { processInboundWebhook } = await import(
      "../../src/queue/processors/inboundWebhookProcessor.js"
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await processInboundWebhook({
      id: "job-skip",
      data: {
        tenantId: String(tenant._id),
        provider: "gmail",
        integrationEventId: String(event._id),
        channelAccountId: String(account._id),
      },
    });

    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
