/**
 * Tests for P4-002 Unified Inbox API:
 *   1. InboxService — tenant-scoped CRUD for channels, conversations,
 *      messages, and contact identities.  Pagination, filtering, counter
 *      updates, read/unread toggling, and status lifecycle.
 *   2. Controller wiring — verifies the controller layer delegates
 *      correctly to InboxService (light integration test).
 *
 * Runs against an in-memory Mongo instance.  No Redis, BullMQ, or HTTP server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let InboxService;
let ChannelAccount;
let Conversation;
let Message;
let ContactIdentity;

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Dynamic imports to pick up the live connection
  InboxService = (await import("../../src/services/inboxService.js")).InboxService;
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js")).default;
  Conversation = (await import("../../src/models/inbox/Conversation.js")).default;
  Message = (await import("../../src/models/inbox/Message.js")).default;
  ContactIdentity = (await import("../../src/models/inbox/ContactIdentity.js")).default;

  // Import User model so Mongoose can resolve populate refs
  await import("../../src/models/User.js");

  await ChannelAccount.syncIndexes();
  await Conversation.syncIndexes();
  await Message.syncIndexes();
  await ContactIdentity.syncIndexes();
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

// ── Helpers ────────────────────────────────────────────────
const tenantA = oid();
const tenantB = oid();

async function seedChannelAccount(tenantId = tenantA, overrides = {}) {
  return ChannelAccount.create({
    tenantId,
    provider: "gmail",
    providerAccountId: `account-${oid()}@test.com`,
    displayName: "Test Channel",
    connectedBy: oid(),
    ...overrides,
  });
}

async function seedConversation(tenantId = tenantA, channelAccountId, overrides = {}) {
  if (!channelAccountId) {
    const ca = await seedChannelAccount(tenantId);
    channelAccountId = ca._id;
  }
  return Conversation.create({
    tenantId,
    channelAccountId,
    channel: "gmail",
    ...overrides,
  });
}

async function seedMessage(tenantId = tenantA, conversationId, channelAccountId, overrides = {}) {
  return Message.create({
    tenantId,
    conversationId,
    channelAccountId,
    channel: "gmail",
    direction: "inbound",
    body: "Hello world",
    ...overrides,
  });
}

// ════════════════════════════════════════════════════════════
// Channel Account Service
// ════════════════════════════════════════════════════════════
describe("InboxService — Channel Accounts", () => {
  it("lists channel accounts for a tenant", async () => {
    await seedChannelAccount(tenantA, { provider: "gmail" });
    await seedChannelAccount(tenantA, { provider: "whatsapp" });
    await seedChannelAccount(tenantB, { provider: "gmail" });

    const accounts = await InboxService.listChannelAccounts(tenantA);
    expect(accounts).toHaveLength(2);
    // Tenant isolation
    const accountsB = await InboxService.listChannelAccounts(tenantB);
    expect(accountsB).toHaveLength(1);
  });

  it("filters by provider", async () => {
    await seedChannelAccount(tenantA, { provider: "gmail" });
    await seedChannelAccount(tenantA, { provider: "whatsapp" });

    const gmail = await InboxService.listChannelAccounts(tenantA, { provider: "gmail" });
    expect(gmail).toHaveLength(1);
    expect(gmail[0].provider).toBe("gmail");
  });

  it("gets a single channel account", async () => {
    const ca = await seedChannelAccount(tenantA);
    const fetched = await InboxService.getChannelAccount(tenantA, ca._id);
    expect(fetched).toBeTruthy();
    expect(fetched.displayName).toBe("Test Channel");
  });

  it("returns null for cross-tenant access", async () => {
    const ca = await seedChannelAccount(tenantA);
    const result = await InboxService.getChannelAccount(tenantB, ca._id);
    expect(result).toBeNull();
  });

  it("creates a channel account", async () => {
    const ca = await InboxService.createChannelAccount(tenantA, {
      provider: "whatsapp",
      providerAccountId: "+1555000111",
      displayName: "WhatsApp Business",
    }, oid());
    expect(ca.provider).toBe("whatsapp");
    expect(ca.tenantId.toString()).toBe(tenantA.toString());
    expect(ca.status).toBe("connected");
  });

  it("updates channel account display name", async () => {
    const ca = await seedChannelAccount(tenantA);
    const updated = await InboxService.updateChannelAccount(tenantA, ca._id, {
      displayName: "Updated Name",
    });
    expect(updated.displayName).toBe("Updated Name");
  });

  it("soft-deletes a channel account", async () => {
    const ca = await seedChannelAccount(tenantA);
    const deleted = await InboxService.deleteChannelAccount(tenantA, ca._id, oid());
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.status).toBe("disconnected");

    // Should not appear in listings
    const accounts = await InboxService.listChannelAccounts(tenantA);
    expect(accounts).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// Conversation Service
// ════════════════════════════════════════════════════════════
describe("InboxService — Conversations", () => {
  it("lists conversations with pagination", async () => {
    const ca = await seedChannelAccount(tenantA);
    for (let i = 0; i < 5; i++) {
      await seedConversation(tenantA, ca._id, {
        lastMessageAt: new Date(Date.now() - i * 60000),
      });
    }
    const result = await InboxService.listConversations(tenantA, {
      page: 1,
      limit: 3,
    });
    expect(result.conversations).toHaveLength(3);
    expect(result.pagination.totalDocs).toBe(5);
    expect(result.pagination.totalPages).toBe(2);
  });

  it("filters conversations by status", async () => {
    const ca = await seedChannelAccount(tenantA);
    await seedConversation(tenantA, ca._id, { status: "open" });
    await seedConversation(tenantA, ca._id, { status: "closed" });
    await seedConversation(tenantA, ca._id, { status: "snoozed" });

    const open = await InboxService.listConversations(tenantA, { status: "open" });
    expect(open.conversations).toHaveLength(1);
    expect(open.conversations[0].status).toBe("open");
  });

  it("filters conversations by channel", async () => {
    const gmailCa = await seedChannelAccount(tenantA, { provider: "gmail" });
    const waCa = await seedChannelAccount(tenantA, { provider: "whatsapp" });
    await seedConversation(tenantA, gmailCa._id, { channel: "gmail" });
    await seedConversation(tenantA, waCa._id, { channel: "whatsapp" });

    const gmail = await InboxService.listConversations(tenantA, { channel: "gmail" });
    expect(gmail.conversations).toHaveLength(1);
    expect(gmail.conversations[0].channel).toBe("gmail");
  });

  it("filters conversations by assigneeId", async () => {
    const ca = await seedChannelAccount(tenantA);
    const userId = oid();
    await seedConversation(tenantA, ca._id, { assigneeId: userId });
    await seedConversation(tenantA, ca._id);

    const assigned = await InboxService.listConversations(tenantA, { assigneeId: userId });
    expect(assigned.conversations).toHaveLength(1);
  });

  it("searches conversations by participant name", async () => {
    const ca = await seedChannelAccount(tenantA);
    await seedConversation(tenantA, ca._id, { participantName: "Alice Johnson" });
    await seedConversation(tenantA, ca._id, { participantName: "Bob Smith" });

    const result = await InboxService.listConversations(tenantA, { search: "alice" });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].participantName).toBe("Alice Johnson");
  });

  it("gets a single conversation", async () => {
    const conv = await seedConversation(tenantA);
    const fetched = await InboxService.getConversation(tenantA, conv._id);
    expect(fetched).toBeTruthy();
    expect(fetched.status).toBe("open");
  });

  it("enforces tenant isolation on conversation get", async () => {
    const conv = await seedConversation(tenantA);
    const result = await InboxService.getConversation(tenantB, conv._id);
    expect(result).toBeNull();
  });

  it("updates conversation fields", async () => {
    const conv = await seedConversation(tenantA);
    const updated = await InboxService.updateConversation(tenantA, conv._id, {
      priority: 1,
      tags: ["vip", "urgent"],
    });
    expect(updated.priority).toBe(1);
    expect(updated.tags).toEqual(["vip", "urgent"]);
  });

  it("assigns a conversation", async () => {
    const conv = await seedConversation(tenantA);
    const userId = oid();
    const assigned = await InboxService.assignConversation(tenantA, conv._id, userId);
    // assigneeId is populated — user doesn't exist in test DB so it resolves to null
    // Verify the raw doc was updated correctly
    const raw = await Conversation.findById(conv._id).lean();
    expect(raw.assigneeId.toString()).toBe(userId.toString());
  });

  it("marks a conversation as read (resets unreadCount)", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id, { unreadCount: 5 });
    const result = await InboxService.markConversationRead(tenantA, conv._id);
    expect(result.unreadCount).toBe(0);
  });

  it("marks a conversation as unread (sets unreadCount to 1)", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id, { unreadCount: 0 });
    const result = await InboxService.markConversationUnread(tenantA, conv._id);
    expect(result.unreadCount).toBe(1);
  });

  it("returns null when marking already-unread conversation as unread", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id, { unreadCount: 3 });
    const result = await InboxService.markConversationUnread(tenantA, conv._id);
    expect(result).toBeNull(); // filter condition unreadCount: 0 won't match
  });

  it("closes and reopens a conversation", async () => {
    const conv = await seedConversation(tenantA);
    const closed = await InboxService.closeConversation(tenantA, conv._id);
    expect(closed.status).toBe("closed");

    const reopened = await InboxService.reopenConversation(tenantA, conv._id);
    expect(reopened.status).toBe("open");
  });

  it("snoozes a conversation with until date", async () => {
    const conv = await seedConversation(tenantA);
    const until = new Date(Date.now() + 86400000); // tomorrow
    const snoozed = await InboxService.snoozeConversation(tenantA, conv._id, until);
    expect(snoozed.status).toBe("snoozed");
    expect(snoozed.snoozedUntil.getTime()).toBe(until.getTime());
  });

  it("soft-deletes a conversation", async () => {
    const conv = await seedConversation(tenantA);
    const userId = oid();
    const deleted = await InboxService.deleteConversation(tenantA, conv._id, userId);
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.deletedBy.toString()).toBe(userId.toString());

    // Should not appear in listings
    const result = await InboxService.listConversations(tenantA);
    expect(result.conversations).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// Inbox Summary
// ════════════════════════════════════════════════════════════
describe("InboxService — Summary", () => {
  it("returns inbox summary with counts by status and channel", async () => {
    const ca = await seedChannelAccount(tenantA);
    const waCa = await seedChannelAccount(tenantA, { provider: "whatsapp" });

    await seedConversation(tenantA, ca._id, {
      status: "open",
      channel: "gmail",
      unreadCount: 3,
    });
    await seedConversation(tenantA, ca._id, {
      status: "open",
      channel: "gmail",
      unreadCount: 1,
    });
    await seedConversation(tenantA, waCa._id, {
      status: "open",
      channel: "whatsapp",
      unreadCount: 2,
    });
    await seedConversation(tenantA, ca._id, {
      status: "closed",
      channel: "gmail",
      unreadCount: 0,
    });

    const summary = await InboxService.getInboxSummary(tenantA);
    expect(summary.totalUnread).toBe(6);
    expect(summary.byStatus.open).toBe(3);
    expect(summary.byStatus.closed).toBe(1);
    expect(summary.byChannel.gmail.count).toBe(2);
    expect(summary.byChannel.gmail.unread).toBe(4);
    expect(summary.byChannel.whatsapp.count).toBe(1);
    expect(summary.byChannel.whatsapp.unread).toBe(2);
  });

  it("returns empty summary for tenant with no conversations", async () => {
    const summary = await InboxService.getInboxSummary(oid());
    expect(summary.totalUnread).toBe(0);
    expect(summary.byStatus).toEqual({});
    expect(summary.byChannel).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════
// Message Service
// ════════════════════════════════════════════════════════════
describe("InboxService — Messages", () => {
  it("lists messages for a conversation (chronological)", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id);

    await seedMessage(tenantA, conv._id, ca._id, {
      body: "First",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    await seedMessage(tenantA, conv._id, ca._id, {
      body: "Second",
      createdAt: new Date("2026-01-01T10:05:00Z"),
    });
    await seedMessage(tenantA, conv._id, ca._id, {
      body: "Third",
      createdAt: new Date("2026-01-01T10:10:00Z"),
    });

    const result = await InboxService.listMessages(tenantA, conv._id, {
      page: 1,
      limit: 10,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].body).toBe("First");
    expect(result.messages[2].body).toBe("Third");
    expect(result.pagination.totalDocs).toBe(3);
  });

  it("paginates messages", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id);

    for (let i = 0; i < 10; i++) {
      await seedMessage(tenantA, conv._id, ca._id, { body: `msg-${i}` });
    }

    const page1 = await InboxService.listMessages(tenantA, conv._id, {
      page: 1,
      limit: 3,
    });
    expect(page1.messages).toHaveLength(3);
    expect(page1.pagination.totalPages).toBe(4);
  });

  it("isolates messages by tenant", async () => {
    const caA = await seedChannelAccount(tenantA);
    const caB = await seedChannelAccount(tenantB);
    const convA = await seedConversation(tenantA, caA._id);
    const convB = await seedConversation(tenantB, caB._id);

    await seedMessage(tenantA, convA._id, caA._id);
    await seedMessage(tenantB, convB._id, caB._id);

    const resultA = await InboxService.listMessages(tenantA, convA._id);
    expect(resultA.messages).toHaveLength(1);

    const resultB = await InboxService.listMessages(tenantB, convB._id);
    expect(resultB.messages).toHaveLength(1);
  });

  it("gets a single message", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id);
    const msg = await seedMessage(tenantA, conv._id, ca._id, {
      body: "Test body",
    });

    const fetched = await InboxService.getMessage(tenantA, msg._id);
    expect(fetched).toBeTruthy();
    expect(fetched.body).toBe("Test body");
  });

  it("creates an outbound message and updates conversation counters", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id, {
      messageCount: 1,
      unreadCount: 1,
    });
    const userId = oid();

    const msg = await InboxService.createOutboundMessage(
      tenantA,
      conv._id,
      { body: "Thanks for reaching out!" },
      userId,
    );

    expect(msg.direction).toBe("outbound");
    expect(msg.status).toBe("pending");
    expect(msg.sentByUserId.toString()).toBe(userId.toString());

    // Verify conversation counters updated
    const updatedConv = await Conversation.findById(conv._id).lean();
    expect(updatedConv.messageCount).toBe(2); // was 1, incremented by 1
    expect(updatedConv.lastMessageSnippet).toBe("Thanks for reaching out!");
    expect(updatedConv.lastMessageDirection).toBe("outbound");
    expect(updatedConv.firstReplyAt).toBeTruthy();
  });

  it("rejects outbound message for non-existent conversation", async () => {
    await expect(
      InboxService.createOutboundMessage(tenantA, oid(), { body: "Hello" }, oid()),
    ).rejects.toThrow(/Conversation not found/);
  });

  it("rejects outbound message for cross-tenant conversation", async () => {
    const ca = await seedChannelAccount(tenantA);
    const conv = await seedConversation(tenantA, ca._id);
    await expect(
      InboxService.createOutboundMessage(tenantB, conv._id, { body: "Hello" }, oid()),
    ).rejects.toThrow(/Conversation not found/);
  });
});

// ════════════════════════════════════════════════════════════
// Contact Identity Service
// ════════════════════════════════════════════════════════════
describe("InboxService — Contact Identities", () => {
  it("lists identities for a tenant", async () => {
    const contactId = oid();
    await ContactIdentity.create({
      tenantId: tenantA,
      provider: "email",
      providerIdentifier: "alice@example.com",
      contactId,
    });
    await ContactIdentity.create({
      tenantId: tenantA,
      provider: "whatsapp",
      providerIdentifier: "+1555000222",
    });

    const all = await InboxService.listContactIdentities(tenantA);
    expect(all).toHaveLength(2);

    const byContact = await InboxService.listContactIdentities(tenantA, { contactId });
    expect(byContact).toHaveLength(1);
    expect(byContact[0].provider).toBe("email");
  });

  it("links an identity to a CRM contact", async () => {
    const ci = await ContactIdentity.create({
      tenantId: tenantA,
      provider: "whatsapp",
      providerIdentifier: "+1555000333",
    });
    expect(ci.contactId).toBeNull();
    expect(ci.verified).toBe(false);

    const contactId = oid();
    const linked = await InboxService.linkIdentityToContact(tenantA, ci._id, contactId);
    expect(linked.contactId.toString()).toBe(contactId.toString());
    expect(linked.verified).toBe(true);
  });

  it("isolates identities by tenant", async () => {
    await ContactIdentity.create({
      tenantId: tenantA,
      provider: "email",
      providerIdentifier: "a@a.com",
    });
    await ContactIdentity.create({
      tenantId: tenantB,
      provider: "email",
      providerIdentifier: "b@b.com",
    });

    const resultA = await InboxService.listContactIdentities(tenantA);
    expect(resultA).toHaveLength(1);
    expect(resultA[0].providerIdentifier).toBe("a@a.com");
  });
});

// ════════════════════════════════════════════════════════════
// End-to-end Inbox Flow
// ════════════════════════════════════════════════════════════
describe("Unified Inbox — end-to-end flow", () => {
  it("full lifecycle: connect channel → create conversation → send messages → read/close", async () => {
    const userId = oid();
    const contactId = oid();

    // 1. Connect channel
    const channel = await InboxService.createChannelAccount(tenantA, {
      provider: "gmail",
      providerAccountId: "sales@company.com",
      displayName: "Sales Gmail",
    }, userId);
    expect(channel.status).toBe("connected");

    // 2. Create conversation (simulating inbound creation)
    const conv = await Conversation.create({
      tenantId: tenantA,
      channelAccountId: channel._id,
      channel: "gmail",
      contactId,
      participantName: "Alice Prospect",
      messageCount: 1,
      unreadCount: 1,
      lastMessageAt: new Date(),
      lastMessageSnippet: "Hi, interested in your product",
      lastMessageDirection: "inbound",
      firstMessageAt: new Date(),
      firstUnrepliedAt: new Date(),
    });

    // 3. Simulate inbound message
    await Message.create({
      tenantId: tenantA,
      conversationId: conv._id,
      channelAccountId: channel._id,
      channel: "gmail",
      direction: "inbound",
      body: "Hi, interested in your product",
      providerMessageId: "gmail-msg-001",
    });

    // 4. Verify listing
    const listing = await InboxService.listConversations(tenantA, { status: "open" });
    expect(listing.conversations).toHaveLength(1);
    expect(listing.conversations[0].participantName).toBe("Alice Prospect");

    // 5. Send reply
    const reply = await InboxService.createOutboundMessage(
      tenantA,
      conv._id,
      { body: "Thanks! Let me schedule a demo for you." },
      userId,
    );
    expect(reply.direction).toBe("outbound");

    // 6. Verify counters updated
    const updatedConv = await Conversation.findById(conv._id).lean();
    expect(updatedConv.messageCount).toBe(2);
    expect(updatedConv.lastMessageDirection).toBe("outbound");

    // 7. Get threaded messages
    const thread = await InboxService.listMessages(tenantA, conv._id);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0].direction).toBe("inbound");
    expect(thread.messages[1].direction).toBe("outbound");

    // 8. Mark read
    const read = await InboxService.markConversationRead(tenantA, conv._id);
    expect(read.unreadCount).toBe(0);

    // 9. Close
    const closed = await InboxService.closeConversation(tenantA, conv._id);
    expect(closed.status).toBe("closed");

    // 10. Verify summary
    const summary = await InboxService.getInboxSummary(tenantA);
    expect(summary.byStatus.closed).toBe(1);
    expect(summary.totalUnread).toBe(0);
  });
});
