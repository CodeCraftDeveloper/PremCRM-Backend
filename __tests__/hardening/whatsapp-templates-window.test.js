/**
 * Tests for P6-003 — WhatsApp templates and 24-hour customer-service
 * window enforcement.
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
let Message;
let WhatsappTemplate;
let TokenVaultService;
let WhatsappOutboundService;
let WhatsappTemplateService;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function createTenantCtx(slug = "p6-003") {
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

async function createConversation(tenant, account, { withInbound = true } = {}) {
  const conversation = await Conversation.create({
    tenantId: tenant._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    providerThreadId: "+15550002222:987654321012345",
    participantName: "Alice Customer",
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

async function seedTemplate(tenant, overrides = {}) {
  return WhatsappTemplateService.upsertTemplate({
    tenantId: tenant._id,
    name: overrides.name || "appointment_reminder",
    language: overrides.language || "en_US",
    category: overrides.category || "UTILITY",
    status: overrides.status || "approved",
    components: overrides.components || [
      {
        type: "BODY",
        text: "Hello {{1}}, your appointment is on {{2}} at {{3}}.",
      },
    ],
    metaTemplateId: overrides.metaTemplateId || "tpl_meta_1",
    createdBy: overrides.createdBy || null,
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
  WhatsappTemplate = (
    await import("../../src/models/inbox/WhatsappTemplate.js")
  ).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  WhatsappOutboundService = (
    await import("../../src/services/whatsappOutboundService.js")
  ).WhatsappOutboundService;
  WhatsappTemplateService = (
    await import("../../src/services/whatsappTemplateService.js")
  ).WhatsappTemplateService;

  await Promise.all([
    ChannelAccount.syncIndexes(),
    Conversation.syncIndexes(),
    Message.syncIndexes(),
    WhatsappTemplate.syncIndexes(),
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

describe("WhatsappTemplate model", () => {
  it("computes bodyParameterCount from {{n}} placeholders on save", async () => {
    const { tenant } = await createTenantCtx("model-params");
    const tpl = await seedTemplate(tenant, {
      components: [
        { type: "BODY", text: "Hi {{1}}, total {{2}}, paid on {{3}}." },
      ],
    });
    expect(tpl.bodyParameterCount).toBe(3);
  });

  it("computes 0 parameters for static body", async () => {
    const { tenant } = await createTenantCtx("model-static");
    const tpl = await seedTemplate(tenant, {
      name: "static_one",
      components: [{ type: "BODY", text: "Welcome to our service!" }],
    });
    expect(tpl.bodyParameterCount).toBe(0);
  });

  it("uses the largest positional placeholder as the count", async () => {
    const { tenant } = await createTenantCtx("model-skip");
    const tpl = await seedTemplate(tenant, {
      name: "skip_template",
      components: [{ type: "BODY", text: "Order {{1}} ships on {{3}}." }],
    });
    expect(tpl.bodyParameterCount).toBe(3);
  });

  it("enforces unique (tenantId, name, language) on non-deleted rows", async () => {
    const { tenant } = await createTenantCtx("model-unique");
    await seedTemplate(tenant);
    // upsert path returns existing without duplication
    const second = await seedTemplate(tenant, { status: "paused" });
    expect(second.status).toBe("paused");
    const count = await WhatsappTemplate.countDocuments({
      tenantId: tenant._id,
      deletedAt: null,
    });
    expect(count).toBe(1);
  });
});

describe("WhatsappTemplateService.findApprovedTemplate", () => {
  it("returns approved tenant-scoped templates", async () => {
    const { tenant } = await createTenantCtx("find-approved");
    await seedTemplate(tenant);
    const found = await WhatsappTemplateService.findApprovedTemplate({
      tenantId: tenant._id,
      name: "appointment_reminder",
      language: "en_US",
    });
    expect(found.name).toBe("appointment_reminder");
  });

  it("rejects pending or rejected templates", async () => {
    const { tenant } = await createTenantCtx("find-pending");
    await seedTemplate(tenant, { status: "pending" });
    await expect(
      WhatsappTemplateService.findApprovedTemplate({
        tenantId: tenant._id,
        name: "appointment_reminder",
        language: "en_US",
      }),
    ).rejects.toThrow(/not approved/i);
  });

  it("scopes by tenant", async () => {
    const { tenant } = await createTenantCtx("find-tenant-a");
    const { tenant: tenantB } = await createTenantCtx("find-tenant-b");
    await seedTemplate(tenant);
    await expect(
      WhatsappTemplateService.findApprovedTemplate({
        tenantId: tenantB._id,
        name: "appointment_reminder",
        language: "en_US",
      }),
    ).rejects.toThrow(/not approved/i);
  });
});

describe("WhatsappTemplateService.buildSendComponents", () => {
  it("rejects when parameter count does not match", async () => {
    const { tenant } = await createTenantCtx("build-mismatch");
    const tpl = await seedTemplate(tenant);
    expect(() =>
      WhatsappTemplateService.buildSendComponents({
        template: tpl,
        components: [{ type: "body", parameters: [{ text: "Alice" }] }],
      }),
    ).toThrow(/requires 3 body parameter\(s\); received 1/);
  });

  it("returns canonical body components with text parameter type", async () => {
    const { tenant } = await createTenantCtx("build-ok");
    const tpl = await seedTemplate(tenant);
    const result = WhatsappTemplateService.buildSendComponents({
      template: tpl,
      components: [
        {
          type: "body",
          parameters: [
            { text: "Alice" },
            { text: "Friday" },
            { text: "10am" },
          ],
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "body",
      parameters: [
        { type: "text", text: "Alice" },
        { type: "text", text: "Friday" },
        { type: "text", text: "10am" },
      ],
    });
  });

  it("returns no body component when template has zero parameters", async () => {
    const { tenant } = await createTenantCtx("build-static");
    const tpl = await seedTemplate(tenant, {
      name: "welcome_static",
      components: [{ type: "BODY", text: "Welcome!" }],
    });
    const result = WhatsappTemplateService.buildSendComponents({
      template: tpl,
      components: [],
    });
    expect(result).toEqual([]);
  });

  it("validates and canonicalizes HEADER text parameters", async () => {
    const { tenant } = await createTenantCtx("build-header-text");
    const tpl = await seedTemplate(tenant, {
      name: "header_text",
      components: [
        { type: "HEADER", format: "TEXT", text: "Invoice {{1}}" },
        { type: "BODY", text: "Your invoice is ready." },
      ],
    });

    const result = WhatsappTemplateService.buildSendComponents({
      template: tpl,
      components: [{ type: "header", parameters: [{ text: "INV-101" }] }],
    });

    expect(result).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", text: "INV-101" }],
      },
    ]);
  });

  it("validates HEADER image and document media parameters", async () => {
    const { tenant } = await createTenantCtx("build-header-media");
    const imageTemplate = await seedTemplate(tenant, {
      name: "image_header",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Photo received." },
      ],
    });
    const documentTemplate = await seedTemplate(tenant, {
      name: "document_header",
      components: [
        { type: "HEADER", format: "DOCUMENT" },
        { type: "BODY", text: "Document attached." },
      ],
    });

    expect(
      WhatsappTemplateService.buildSendComponents({
        template: imageTemplate,
        components: [
          { type: "header", parameters: [{ image: { id: "media-image-1" } }] },
        ],
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [{ type: "image", image: { id: "media-image-1" } }],
      },
    ]);

    expect(
      WhatsappTemplateService.buildSendComponents({
        template: documentTemplate,
        components: [
          {
            type: "header",
            parameters: [
              {
                document: {
                  id: "media-doc-1",
                  filename: "invoice.pdf",
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "document",
            document: { id: "media-doc-1", filename: "invoice.pdf" },
          },
        ],
      },
    ]);
  });

  it("validates BUTTON URL and quick-reply parameters against schema", async () => {
    const { tenant } = await createTenantCtx("build-buttons");
    const tpl = await seedTemplate(tenant, {
      name: "button_template",
      components: [
        { type: "BODY", text: "Choose an action." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "View",
              url: "https://example.com/orders/{{1}}",
            },
            { type: "QUICK_REPLY", text: "Confirm" },
          ],
        },
      ],
    });

    const result = WhatsappTemplateService.buildSendComponents({
      template: tpl,
      components: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "ord_123" }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "confirm:ord_123" }],
        },
      ],
    });

    expect(result).toEqual([
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "ord_123" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "confirm:ord_123" }],
      },
    ]);
  });

  it("rejects malformed BUTTON parameters", async () => {
    const { tenant } = await createTenantCtx("build-button-bad");
    const tpl = await seedTemplate(tenant, {
      name: "bad_button_template",
      components: [
        { type: "BODY", text: "Open your order." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "View",
              url: "https://example.com/orders/{{1}}",
            },
          ],
        },
      ],
    });

    expect(() =>
      WhatsappTemplateService.buildSendComponents({
        template: tpl,
        components: [
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: "wrong" }],
          },
        ],
      }),
    ).toThrow(/button 0 must use sub_type url/);
  });
});

describe("getCustomerServiceWindow", () => {
  it("reports open when an inbound message exists in the last 24h", async () => {
    const { tenant, user } = await createTenantCtx("window-open");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const status = await WhatsappOutboundService.getCustomerServiceWindow({
      tenantId: tenant._id,
      conversationId: conversation._id,
    });
    expect(status.open).toBe(true);
    expect(status.lastInboundAt).toBeTruthy();
    expect(status.msRemaining).toBeGreaterThan(0);
  });

  it("reports closed when no inbound message exists", async () => {
    const { tenant, user } = await createTenantCtx("window-no-inbound");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });

    const status = await WhatsappOutboundService.getCustomerServiceWindow({
      tenantId: tenant._id,
      conversationId: conversation._id,
    });
    expect(status.open).toBe(false);
    expect(status.lastInboundAt).toBeNull();
    expect(status.msRemaining).toBe(0);
  });

  it("reports closed when last inbound is older than 24h", async () => {
    const { tenant, user } = await createTenantCtx("window-stale");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await Message.create({
      tenantId: tenant._id,
      conversationId: conversation._id,
      channelAccountId: account._id,
      channel: "whatsapp",
      direction: "inbound",
      status: "sent",
      contentType: "text",
      body: "Old hello",
      providerMessageId: `wamid.old-${conversation._id}`,
      providerTimestamp: twoDaysAgo,
      createdAt: twoDaysAgo,
    });

    const status = await WhatsappOutboundService.getCustomerServiceWindow({
      tenantId: tenant._id,
      conversationId: conversation._id,
    });
    expect(status.open).toBe(false);
    expect(status.lastInboundAt).toBeTruthy();
    expect(status.msRemaining).toBe(0);
  });
});

describe("composeDraft enforces the 24h window", () => {
  it("blocks freeform sends when window is closed", async () => {
    const { tenant, user } = await createTenantCtx("compose-blocked");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });

    await expect(
      WhatsappOutboundService.composeDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        body: "Late freeform",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/customer-service window is closed/i);
  });

  it("allows freeform sends when window is open", async () => {
    const { tenant, user } = await createTenantCtx("compose-open");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);

    const { message } = await WhatsappOutboundService.composeDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      body: "Within window",
      sentByUserId: user._id,
    });
    expect(message.status).toBe("pending");
    expect(message.contentType).toBe("text");
  });
});

describe("composeTemplateDraft", () => {
  it("creates a pending template Message regardless of window state", async () => {
    const { tenant, user } = await createTenantCtx("template-no-window");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });
    await seedTemplate(tenant);

    const { message, approvalRequest, template } =
      await WhatsappOutboundService.composeTemplateDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        templateName: "appointment_reminder",
        language: "en_US",
        components: [
          {
            type: "body",
            parameters: [
              { text: "Alice" },
              { text: "Friday" },
              { text: "10am" },
            ],
          },
        ],
        to: "+15550002222",
        sentByUserId: user._id,
      });

    expect(message.status).toBe("pending");
    expect(message.contentType).toBe("template");
    expect(message.body).toBe(
      "Hello Alice, your appointment is on Friday at 10am.",
    );
    const tplMeta = message.providerMeta.whatsapp.template;
    expect(tplMeta.name).toBe("appointment_reminder");
    expect(tplMeta.language).toBe("en_US");
    expect(tplMeta.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Alice" },
          { type: "text", text: "Friday" },
          { type: "text", text: "10am" },
        ],
      },
    ]);
    expect(approvalRequest.type).toBe("whatsapp.send");
    expect(approvalRequest.metadata.template.name).toBe("appointment_reminder");
    expect(template.name).toBe("appointment_reminder");
  });

  it("rejects when template parameter count is wrong", async () => {
    const { tenant, user } = await createTenantCtx("template-bad-params");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);
    await seedTemplate(tenant);

    await expect(
      WhatsappOutboundService.composeTemplateDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        templateName: "appointment_reminder",
        language: "en_US",
        components: [{ type: "body", parameters: [{ text: "Alice" }] }],
        to: "+15550002222",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/requires 3 body parameter\(s\); received 1/);
  });

  it("rejects when template is not approved", async () => {
    const { tenant, user } = await createTenantCtx("template-not-approved");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);
    await seedTemplate(tenant, { status: "rejected" });

    await expect(
      WhatsappOutboundService.composeTemplateDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        templateName: "appointment_reminder",
        language: "en_US",
        components: [],
        to: "+15550002222",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/not approved/i);
  });

  it("rejects malformed BUTTON parameters before creating a draft", async () => {
    const { tenant, user } = await createTenantCtx("template-bad-button");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account);
    await seedTemplate(tenant, {
      name: "compose_button_template",
      components: [
        { type: "BODY", text: "Open your order." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "View",
              url: "https://example.com/orders/{{1}}",
            },
          ],
        },
      ],
    });

    await expect(
      WhatsappOutboundService.composeTemplateDraft({
        tenantId: tenant._id,
        conversationId: conversation._id,
        templateName: "compose_button_template",
        language: "en_US",
        components: [
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [],
          },
        ],
        to: "+15550002222",
        sentByUserId: user._id,
      }),
    ).rejects.toThrow(/URL button 0 requires 1 parameter/);

    expect(
      await Message.countDocuments({
        tenantId: tenant._id,
        conversationId: conversation._id,
        direction: "outbound",
        contentType: "template",
      }),
    ).toBe(0);
  });
});

describe("sendApprovedMessage with templates", () => {
  it("posts the Cloud API template payload and marks the message sent", async () => {
    const { tenant, user } = await createTenantCtx("send-template");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });
    await seedTemplate(tenant);
    const { message } = await WhatsappOutboundService.composeTemplateDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      templateName: "appointment_reminder",
      language: "en_US",
      components: [
        {
          type: "body",
          parameters: [
            { text: "Alice" },
            { text: "Friday" },
            { text: "10am" },
          ],
        },
      ],
      to: "+15550002222",
      sentByUserId: user._id,
    });

    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        expect(String(url)).toContain("/v20.0/987654321012345/messages");
        captured = JSON.parse(init.body);
        return jsonResponse({
          messages: [{ id: "wamid.template-out-1" }],
        });
      }),
    );

    const result = await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(result.providerMessageId).toBe("wamid.template-out-1");
    expect(captured).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550002222",
      type: "template",
      template: {
        name: "appointment_reminder",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Alice" },
              { type: "text", text: "Friday" },
              { type: "text", text: "10am" },
            ],
          },
        ],
      },
    });
    expect(captured.text).toBeUndefined();

    const reloaded = await Message.findById(message._id);
    expect(reloaded.status).toBe("sent");
    expect(reloaded.providerMessageId).toBe("wamid.template-out-1");
  });

  it("omits the components key when the template has zero parameters", async () => {
    const { tenant, user } = await createTenantCtx("send-template-static");
    const account = await createWhatsappAccount(tenant, user);
    const conversation = await createConversation(tenant, account, {
      withInbound: false,
    });
    await seedTemplate(tenant, {
      name: "welcome_static",
      components: [{ type: "BODY", text: "Welcome!" }],
    });
    const { message } = await WhatsappOutboundService.composeTemplateDraft({
      tenantId: tenant._id,
      conversationId: conversation._id,
      templateName: "welcome_static",
      language: "en_US",
      components: [],
      to: "+15550002222",
      sentByUserId: user._id,
    });

    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        captured = JSON.parse(init.body);
        return jsonResponse({ messages: [{ id: "wamid.static" }] });
      }),
    );

    await WhatsappOutboundService.sendApprovedMessage({
      tenantId: tenant._id,
      messageId: message._id,
    });

    expect(captured.template.components).toBeUndefined();
    expect(captured.template.name).toBe("welcome_static");
  });
});
