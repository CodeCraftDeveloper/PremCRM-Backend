/**
 * Tests for P4-001 Unified Inbox Data Models:
 *   1. ChannelAccount — provider uniqueness, tenant isolation, status enum,
 *      credentials select:false, sync state.
 *   2. ContactIdentity — identity uniqueness, email normalisation,
 *      CRM Contact linkage, provider enum.
 *   3. Conversation — provider thread dedup (partial unique index),
 *      status lifecycle, channel enum, denormalised counters,
 *      tenant isolation, CRM entity links.
 *   4. Message — provider message dedup, direction/status enums,
 *      attachment sub-doc, AI metadata, tenant isolation,
 *      conversation linkage.
 *
 * These tests run against an in-memory Mongo instance.  No Redis or
 * BullMQ workers — model layer only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let ChannelAccount;
let ContactIdentity;
let Conversation;
let Message;

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js")).default;
  ContactIdentity = (await import("../../src/models/inbox/ContactIdentity.js")).default;
  Conversation = (await import("../../src/models/inbox/Conversation.js")).default;
  Message = (await import("../../src/models/inbox/Message.js")).default;

  await ChannelAccount.syncIndexes();
  await ContactIdentity.syncIndexes();
  await Conversation.syncIndexes();
  await Message.syncIndexes();
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
function buildChannelAccount(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    provider: overrides.provider || "gmail",
    providerAccountId: overrides.providerAccountId || "sales@acme.com",
    displayName: overrides.displayName || "Sales Inbox",
    connectedBy: overrides.connectedBy || oid(),
    ...overrides,
  };
}

function buildContactIdentity(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    provider: overrides.provider || "email",
    providerIdentifier: overrides.providerIdentifier || "alice@example.com",
    ...overrides,
  };
}

function buildConversation(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    channelAccountId: overrides.channelAccountId || oid(),
    channel: overrides.channel || "gmail",
    ...overrides,
  };
}

function buildMessage(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    conversationId: overrides.conversationId || oid(),
    channelAccountId: overrides.channelAccountId || oid(),
    channel: overrides.channel || "gmail",
    direction: overrides.direction || "inbound",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// ChannelAccount
// ════════════════════════════════════════════════════════════
describe("ChannelAccount model", () => {
  it("creates a valid channel account with defaults", async () => {
    const ca = await ChannelAccount.create(buildChannelAccount());
    expect(ca.provider).toBe("gmail");
    expect(ca.status).toBe("connected");
    expect(ca.consecutiveErrors).toBe(0);
    expect(ca.deletedAt).toBeNull();
  });

  it("rejects unknown provider enum values", async () => {
    await expect(
      ChannelAccount.create(buildChannelAccount({ provider: "telegram" })),
    ).rejects.toThrow();
  });

  it("rejects missing required fields", async () => {
    await expect(
      ChannelAccount.create({ tenantId: oid(), connectedBy: oid() }),
    ).rejects.toThrow(/provider/i);
  });

  it("enforces unique (tenant, provider, providerAccountId)", async () => {
    const tenantId = oid();
    const base = buildChannelAccount({
      tenantId,
      provider: "gmail",
      providerAccountId: "dup@acme.com",
    });
    await ChannelAccount.create(base);
    await expect(ChannelAccount.create(base)).rejects.toThrow(/duplicate/i);
  });

  it("allows same providerAccountId for different tenants", async () => {
    const shared = { provider: "gmail", providerAccountId: "shared@acme.com" };
    const a = await ChannelAccount.create(buildChannelAccount({ ...shared, tenantId: oid() }));
    const b = await ChannelAccount.create(buildChannelAccount({ ...shared, tenantId: oid() }));
    expect(a._id.toString()).not.toBe(b._id.toString());
  });

  it("does not select credentials by default", async () => {
    const tenantId = oid();
    await ChannelAccount.create(
      buildChannelAccount({
        tenantId,
        credentials: { accessToken: "secret123", refreshToken: "refresh456" },
      }),
    );
    const found = await ChannelAccount.findOne({ tenantId });
    expect(found.credentials).toBeUndefined();

    // Explicit select should return credentials.
    const withCreds = await ChannelAccount.findOne({ tenantId }).select("+credentials");
    expect(withCreds.credentials.accessToken).toBe("secret123");
  });

  it("isolates channel accounts by tenantId", async () => {
    const tA = oid();
    const tB = oid();
    await ChannelAccount.create(buildChannelAccount({ tenantId: tA, providerAccountId: "a@a.com" }));
    await ChannelAccount.create(buildChannelAccount({ tenantId: tB, providerAccountId: "b@b.com" }));
    expect(await ChannelAccount.countDocuments({ tenantId: tA })).toBe(1);
    expect(await ChannelAccount.countDocuments({ tenantId: tB })).toBe(1);
  });

  it("supports all four provider values", async () => {
    const tenantId = oid();
    for (const provider of ["gmail", "whatsapp", "meta", "gmb"]) {
      const ca = await ChannelAccount.create(
        buildChannelAccount({ tenantId, provider, providerAccountId: `${provider}-id` }),
      );
      expect(ca.provider).toBe(provider);
    }
  });
});

// ════════════════════════════════════════════════════════════
// ContactIdentity
// ════════════════════════════════════════════════════════════
describe("ContactIdentity model", () => {
  it("creates a valid identity with defaults", async () => {
    const ci = await ContactIdentity.create(buildContactIdentity());
    expect(ci.provider).toBe("email");
    expect(ci.verified).toBe(false);
    expect(ci.contactId).toBeNull();
  });

  it("normalises email identifiers to lowercase on save", async () => {
    const ci = await ContactIdentity.create(
      buildContactIdentity({ providerIdentifier: "ALICE@Example.COM" }),
    );
    expect(ci.providerIdentifier).toBe("alice@example.com");
  });

  it("does not lowercase non-email identifiers", async () => {
    const ci = await ContactIdentity.create(
      buildContactIdentity({ provider: "whatsapp", providerIdentifier: "+1234567890" }),
    );
    expect(ci.providerIdentifier).toBe("+1234567890");
  });

  it("enforces unique (tenant, provider, providerIdentifier)", async () => {
    const tenantId = oid();
    const base = buildContactIdentity({
      tenantId,
      provider: "email",
      providerIdentifier: "dup@example.com",
    });
    await ContactIdentity.create(base);
    await expect(ContactIdentity.create(base)).rejects.toThrow(/duplicate/i);
  });

  it("allows same identifier across different providers", async () => {
    const tenantId = oid();
    const a = await ContactIdentity.create(
      buildContactIdentity({ tenantId, provider: "email", providerIdentifier: "alice@ex.com" }),
    );
    const b = await ContactIdentity.create(
      buildContactIdentity({ tenantId, provider: "meta", providerIdentifier: "alice@ex.com" }),
    );
    expect(a._id.toString()).not.toBe(b._id.toString());
  });

  it("links to a CRM Contact", async () => {
    const contactId = oid();
    const ci = await ContactIdentity.create(
      buildContactIdentity({ contactId }),
    );
    expect(ci.contactId.toString()).toBe(contactId.toString());
  });

  it("supports all identity providers", async () => {
    const tenantId = oid();
    const providers = ["email", "whatsapp", "meta", "gmb", "phone"];
    for (let i = 0; i < providers.length; i++) {
      const ci = await ContactIdentity.create(
        buildContactIdentity({
          tenantId,
          provider: providers[i],
          providerIdentifier: `id-${i}`,
        }),
      );
      expect(ci.provider).toBe(providers[i]);
    }
  });

  it("isolates identities by tenantId", async () => {
    const tA = oid();
    const tB = oid();
    await ContactIdentity.create(buildContactIdentity({ tenantId: tA, providerIdentifier: "a@a.com" }));
    await ContactIdentity.create(buildContactIdentity({ tenantId: tB, providerIdentifier: "b@b.com" }));
    expect(await ContactIdentity.countDocuments({ tenantId: tA })).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
// Conversation
// ════════════════════════════════════════════════════════════
describe("Conversation model", () => {
  it("creates a valid conversation with defaults", async () => {
    const conv = await Conversation.create(buildConversation());
    expect(conv.status).toBe("open");
    expect(conv.messageCount).toBe(0);
    expect(conv.unreadCount).toBe(0);
    expect(conv.priority).toBe(3);
    expect(conv.tags).toEqual([]);
  });

  it("rejects unknown channel enum", async () => {
    await expect(
      Conversation.create(buildConversation({ channel: "telegram" })),
    ).rejects.toThrow();
  });

  it("rejects unknown status enum", async () => {
    await expect(
      Conversation.create(buildConversation({ status: "archived" })),
    ).rejects.toThrow();
  });

  it("enforces unique providerThreadId per (tenant, channelAccount)", async () => {
    const tenantId = oid();
    const channelAccountId = oid();
    const base = buildConversation({
      tenantId,
      channelAccountId,
      providerThreadId: "thread-abc",
    });
    await Conversation.create(base);
    await expect(Conversation.create(base)).rejects.toThrow();
  });

  it("allows multiple conversations with null providerThreadId (partial index)", async () => {
    const tenantId = oid();
    const channelAccountId = oid();
    const base = buildConversation({ tenantId, channelAccountId });
    const c1 = await Conversation.create(base);
    const c2 = await Conversation.create(base);
    expect(c1._id.toString()).not.toBe(c2._id.toString());
  });

  it("links to CRM Contact and Deal", async () => {
    const contactId = oid();
    const dealId = oid();
    const conv = await Conversation.create(
      buildConversation({ contactId, dealId }),
    );
    expect(conv.contactId.toString()).toBe(contactId.toString());
    expect(conv.dealId.toString()).toBe(dealId.toString());
  });

  it("isolates conversations by tenantId", async () => {
    const tA = oid();
    const tB = oid();
    await Conversation.create(buildConversation({ tenantId: tA }));
    await Conversation.create(buildConversation({ tenantId: tB }));
    expect(await Conversation.countDocuments({ tenantId: tA })).toBe(1);
    expect(await Conversation.countDocuments({ tenantId: tB })).toBe(1);
  });

  it("supports denormalised message counters and snippet", async () => {
    const conv = await Conversation.create(
      buildConversation({
        messageCount: 5,
        unreadCount: 2,
        lastMessageSnippet: "Hey, are you available?",
        lastMessageDirection: "inbound",
        lastMessageAt: new Date(),
      }),
    );
    expect(conv.messageCount).toBe(5);
    expect(conv.unreadCount).toBe(2);
    expect(conv.lastMessageSnippet).toBe("Hey, are you available?");
    expect(conv.lastMessageDirection).toBe("inbound");
  });

  it("supports SLA timestamp fields", async () => {
    const now = new Date();
    const conv = await Conversation.create(
      buildConversation({
        firstMessageAt: now,
        firstUnrepliedAt: now,
        firstReplyAt: null,
      }),
    );
    expect(conv.firstMessageAt.getTime()).toBe(now.getTime());
    expect(conv.firstUnrepliedAt.getTime()).toBe(now.getTime());
    expect(conv.firstReplyAt).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// Message
// ════════════════════════════════════════════════════════════
describe("Message model", () => {
  it("creates a valid inbound message with defaults", async () => {
    const msg = await Message.create(buildMessage());
    expect(msg.direction).toBe("inbound");
    expect(msg.status).toBe("sent");
    expect(msg.contentType).toBe("text");
    expect(msg.aiGenerated).toBe(false);
    expect(msg.attachments).toEqual([]);
  });

  it("rejects unknown direction enum", async () => {
    await expect(
      Message.create(buildMessage({ direction: "sideways" })),
    ).rejects.toThrow();
  });

  it("rejects unknown status enum", async () => {
    await expect(
      Message.create(buildMessage({ status: "exploded" })),
    ).rejects.toThrow();
  });

  it("enforces unique providerMessageId per (tenant, channelAccount)", async () => {
    const tenantId = oid();
    const channelAccountId = oid();
    const base = buildMessage({
      tenantId,
      channelAccountId,
      providerMessageId: "msg-123",
    });
    await Message.create(base);
    await expect(Message.create(base)).rejects.toThrow();
  });

  it("allows multiple messages with null providerMessageId", async () => {
    const tenantId = oid();
    const channelAccountId = oid();
    const base = buildMessage({ tenantId, channelAccountId });
    const m1 = await Message.create(base);
    const m2 = await Message.create(base);
    expect(m1._id.toString()).not.toBe(m2._id.toString());
  });

  it("stores attachments", async () => {
    const msg = await Message.create(
      buildMessage({
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 45_000,
            storageKey: "uploads/tenant/invoice.pdf",
          },
        ],
      }),
    );
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].filename).toBe("invoice.pdf");
    expect(msg.attachments[0].sizeBytes).toBe(45_000);
  });

  it("tracks AI generation metadata", async () => {
    const aiRunId = oid();
    const approvalId = oid();
    const msg = await Message.create(
      buildMessage({
        direction: "outbound",
        aiGenerated: true,
        aiRunId,
        approvalRequestId: approvalId,
      }),
    );
    expect(msg.aiGenerated).toBe(true);
    expect(msg.aiRunId.toString()).toBe(aiRunId.toString());
    expect(msg.approvalRequestId.toString()).toBe(approvalId.toString());
  });

  it("isolates messages by tenantId", async () => {
    const tA = oid();
    const tB = oid();
    await Message.create(buildMessage({ tenantId: tA }));
    await Message.create(buildMessage({ tenantId: tB }));
    expect(await Message.countDocuments({ tenantId: tA })).toBe(1);
    expect(await Message.countDocuments({ tenantId: tB })).toBe(1);
  });

  it("supports all message content types", async () => {
    const types = [
      "text", "html", "image", "video", "audio", "document",
      "location", "contact_card", "template", "interactive",
      "reaction", "system",
    ];
    for (const ct of types) {
      const msg = await Message.create(buildMessage({ contentType: ct }));
      expect(msg.contentType).toBe(ct);
    }
  });

  it("tracks delivery lifecycle timestamps", async () => {
    const now = new Date();
    const msg = await Message.create(
      buildMessage({
        direction: "outbound",
        status: "delivered",
        providerTimestamp: now,
        deliveredAt: now,
      }),
    );
    expect(msg.deliveredAt.getTime()).toBe(now.getTime());
    expect(msg.providerTimestamp.getTime()).toBe(now.getTime());
  });
});

// ════════════════════════════════════════════════════════════
// Cross-model integration
// ════════════════════════════════════════════════════════════
describe("Unified Inbox — cross-model integration", () => {
  it("links ChannelAccount → Conversation → Message → ContactIdentity", async () => {
    const tenantId = oid();
    const contactId = oid();

    // 1. Channel account
    const ca = await ChannelAccount.create(
      buildChannelAccount({ tenantId, provider: "whatsapp", providerAccountId: "+1555000111" }),
    );

    // 2. Contact identity
    const ci = await ContactIdentity.create(
      buildContactIdentity({
        tenantId,
        contactId,
        provider: "whatsapp",
        providerIdentifier: "+1555000222",
        displayName: "Alice",
      }),
    );

    // 3. Conversation
    const conv = await Conversation.create(
      buildConversation({
        tenantId,
        channelAccountId: ca._id,
        channel: "whatsapp",
        contactId,
        contactIdentityId: ci._id,
        providerThreadId: "+1555000222:+1555000111",
        participantName: "Alice",
      }),
    );

    // 4. Messages
    const inbound = await Message.create(
      buildMessage({
        tenantId,
        conversationId: conv._id,
        channelAccountId: ca._id,
        channel: "whatsapp",
        direction: "inbound",
        body: "Hi, I need help with my order",
        providerMessageId: "wamid.inbound1",
        contactIdentityId: ci._id,
        senderName: "Alice",
        senderIdentifier: "+1555000222",
      }),
    );

    const outbound = await Message.create(
      buildMessage({
        tenantId,
        conversationId: conv._id,
        channelAccountId: ca._id,
        channel: "whatsapp",
        direction: "outbound",
        body: "Sure, let me check your order status",
        providerMessageId: "wamid.outbound1",
        sentByUserId: oid(),
      }),
    );

    // Verify linkage
    expect(inbound.conversationId.toString()).toBe(conv._id.toString());
    expect(inbound.channelAccountId.toString()).toBe(ca._id.toString());
    expect(inbound.contactIdentityId.toString()).toBe(ci._id.toString());
    expect(outbound.direction).toBe("outbound");

    // Verify queries
    const convMessages = await Message.find({
      tenantId,
      conversationId: conv._id,
    }).sort({ createdAt: 1 });
    expect(convMessages).toHaveLength(2);
    expect(convMessages[0].direction).toBe("inbound");
    expect(convMessages[1].direction).toBe("outbound");

    // Verify contact identity → conversation linkage
    const contactConvs = await Conversation.find({ tenantId, contactId });
    expect(contactConvs).toHaveLength(1);
    expect(contactConvs[0].channel).toBe("whatsapp");
  });

  it("barrel exports all models and constants", async () => {
    const barrel = await import("../../src/models/inbox/index.js");
    expect(barrel.ChannelAccount).toBeDefined();
    expect(barrel.ContactIdentity).toBeDefined();
    expect(barrel.Conversation).toBeDefined();
    expect(barrel.Message).toBeDefined();
    expect(barrel.CHANNEL_PROVIDERS).toContain("gmail");
    expect(barrel.IDENTITY_PROVIDERS).toContain("email");
    expect(barrel.CONVERSATION_CHANNELS).toContain("whatsapp");
    expect(barrel.MESSAGE_DIRECTIONS).toContain("inbound");
    expect(barrel.MESSAGE_STATUSES).toContain("delivered");
    expect(barrel.MESSAGE_CONTENT_TYPES).toContain("text");
  });

  it("main models index re-exports inbox models", async () => {
    const idx = await import("../../src/models/index.js");
    expect(idx.ChannelAccount).toBeDefined();
    expect(idx.ContactIdentity).toBeDefined();
    expect(idx.Conversation).toBeDefined();
    expect(idx.Message).toBeDefined();
    expect(idx.CHANNEL_PROVIDERS).toBeDefined();
  });
});
