/**
 * Tests for P7-002 — AI Social Content Generator.
 *
 * Covers tenant isolation, brand-profile required, output structure
 * validation, no-invented-claims guardrail, forbidden-claims guardrail,
 * usage metering, approval default, cross-tenant approval, processor
 * routing, and the brand-profile upsert path.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let Tenant;
let User;
let BrandProfile;
let PromptTemplate;
let AIRun;
let ContentDraft;
let ApprovalRequest;
let UsageMeter;
let AISocialContentService;
let AISocialPermanentError;
let AIProviderClient;
let processAiDraft;
let NonRetryableError;

async function createTenantCtx(slug = "p7-002") {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "agency",
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

async function seedBrandProfile(tenant, overrides = {}) {
  return BrandProfile.create({
    tenantId: tenant._id,
    businessName: "Acme Coffee",
    description: "Specialty coffee roastery in Brooklyn.",
    industry: "coffee",
    products: [
      { name: "Single-Origin Espresso", description: "Ethiopian Yirgacheffe." },
    ],
    services: [{ name: "Wholesale Beans" }],
    offers: [
      {
        name: "Spring Sale",
        discount: "15% off",
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
      },
    ],
    locations: [{ name: "Brooklyn HQ", region: "NY", country: "US" }],
    slogans: ["Roasted in Brooklyn"],
    audience: { demographics: "Coffee enthusiasts 25-45" },
    brandVoice: { tone: "warm", vocabulary: ["roastery", "single-origin"] },
    campaignGoals: [{ name: "Summer awareness", kpi: "Reach" }],
    approvedClaims: ["Brooklyn-roasted since 2018"],
    forbiddenClaims: ["competitor-x", "unsupported-cure"],
    defaultChannels: ["instagram"],
    defaultLanguage: "en",
    ...overrides,
  });
}

async function seedPromptTemplate(tenant, overrides = {}) {
  return PromptTemplate.create({
    tenantId: tenant._id,
    name: "social.caption.generic",
    category: "social_caption",
    agent: "social.caption_generator",
    status: "active",
    version: 1,
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "You generate social captions strictly from approved facts.",
    userPromptTemplate: "Generate a social caption for {{brand_profile.businessName}}.",
    requiredContext: ["brand_profile"],
    contextSources: ["brand_profile"],
    requiresApproval: true,
    ...overrides,
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  BrandProfile = (await import("../../src/models/BrandProfile.js")).default;
  PromptTemplate = (await import("../../src/models/PromptTemplate.js")).default;
  AIRun = (await import("../../src/models/AIRun.js")).default;
  ContentDraft = (await import("../../src/models/ContentDraft.js")).default;
  ApprovalRequest = (await import("../../src/models/ApprovalRequest.js")).default;
  UsageMeter = (await import("../../src/models/UsageMeter.js")).default;
  const svc = await import(
    "../../src/services/ai/aiSocialContentService.js"
  );
  AISocialContentService = svc.AISocialContentService;
  AISocialPermanentError = svc.AISocialPermanentError;
  const provider = await import(
    "../../src/services/ai/aiProviderClient.js"
  );
  AIProviderClient = provider.AIProviderClient;
  const proc = await import(
    "../../src/queue/processors/aiDraftProcessor.js"
  );
  processAiDraft = proc.processAiDraft;
  const errs = await import("../../src/queue/errors.js");
  NonRetryableError = errs.NonRetryableError;

  await Promise.all([
    BrandProfile.syncIndexes(),
    PromptTemplate.syncIndexes(),
    AIRun.syncIndexes(),
    ContentDraft.syncIndexes(),
    ApprovalRequest.syncIndexes(),
    UsageMeter.syncIndexes(),
  ]);
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

describe("AISocialContentService.generateSocialContent", () => {
  it("creates an AIRun, ContentDraft, and pending ApprovalRequest", async () => {
    const { tenant, user } = await createTenantCtx("happy");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    const result = await AISocialContentService.generateSocialContent({
      tenantId: tenant._id,
      channel: "instagram",
      campaignGoal: "Summer awareness",
      triggeredBy: user._id,
    });

    expect(result.aiRun.status).toBe("succeeded");
    expect(String(result.aiRun.tenantId)).toBe(String(tenant._id));
    expect(result.draft.status).toBe("pending_approval");
    expect(result.draft.contentType).toBe("social_caption");
    expect(result.draft.channel).toBe("instagram");
    expect(result.draft.requiresApproval).toBe(true);
    expect(result.draft.variants.length).toBeGreaterThan(0);
    expect(result.draft.variants[0].body).toMatch(/Acme Coffee/i);
    expect(result.draft.selectedVariantId).toBe(result.draft.variants[0].id);

    expect(result.approvalRequest).toBeTruthy();
    expect(result.approvalRequest.type).toBe("ai.action");
    expect(result.approvalRequest.status).toBe("pending");
    expect(result.approvalRequest.aiGenerated).toBe(true);
    expect(result.approvalRequest.relatedEntityType).toBe("content_draft");
    expect(String(result.approvalRequest.relatedEntityId)).toBe(
      String(result.draft._id),
    );

    // ContentDraft is back-linked to the approval request
    expect(String(result.draft.approvalRequestId)).toBe(
      String(result.approvalRequest._id),
    );
  });

  it("rejects when the brand profile is missing", async () => {
    const { tenant, user } = await createTenantCtx("no-brand");
    await seedPromptTemplate(tenant);

    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenant._id,
        channel: "instagram",
        triggeredBy: user._id,
      }),
    ).rejects.toThrow(/brand profile is required/i);

    // No AIRun / draft is persisted on the missing-profile path
    expect(await AIRun.countDocuments({ tenantId: tenant._id })).toBe(0);
    expect(await ContentDraft.countDocuments({ tenantId: tenant._id })).toBe(0);
  });

  it("rejects unsupported channel without a provider call", async () => {
    const { tenant, user } = await createTenantCtx("bad-channel");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenant._id,
        channel: "snail-mail",
        triggeredBy: user._id,
      }),
    ).rejects.toThrow(/not a supported social channel/i);
  });

  it("rejects when no active prompt template exists", async () => {
    const { tenant, user } = await createTenantCtx("no-prompt");
    await seedBrandProfile(tenant);

    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenant._id,
        channel: "instagram",
        triggeredBy: user._id,
      }),
    ).rejects.toThrow(/No active prompt template/i);
  });

  it("blocks output that contains a forbiddenClaims phrase", async () => {
    const { tenant, user } = await createTenantCtx("forbidden");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    AIProviderClient.registerProvider("test-forbidden", {
      name: "test-forbidden",
      async generate() {
        return {
          output: {
            variants: [
              {
                id: "v1",
                body: "Try competitor-x today!",
                hashtags: ["#try"],
                cta: "Buy now",
                confidence: 0.9,
                rationale: "x",
              },
            ],
            confidence: 0.9,
            requiredApproval: true,
          },
          usage: {
            promptTokens: 5,
            completionTokens: 5,
            totalTokens: 10,
            costMicroUsd: 0,
          },
          model: "test",
          providerRequestId: "test",
          latencyMs: 1,
        };
      },
    });

    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenant._id,
        channel: "instagram",
        triggeredBy: user._id,
        providerName: "test-forbidden",
      }),
    ).rejects.toThrow(/guardrail blocked/i);

    const blocked = await AIRun.findOne({ tenantId: tenant._id }).lean();
    expect(blocked.status).toBe("blocked_by_guardrail");
    expect(blocked.guardrailBlock?.reason).toMatch(/competitor-x/i);
    // Tokens are still metered when the provider was called
    const meter = await UsageMeter.findOne({ tenantId: tenant._id }).lean();
    expect(meter.aiRuns).toBe(1);
    expect(meter.aiTokens).toBe(10);
  });

  it("rejects malformed provider output (no variants)", async () => {
    const { tenant, user } = await createTenantCtx("malformed");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    AIProviderClient.registerProvider("test-malformed", {
      name: "test-malformed",
      async generate() {
        return {
          output: { variants: [] },
          usage: { totalTokens: 0 },
          model: "test",
          providerRequestId: "test",
          latencyMs: 0,
        };
      },
    });

    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenant._id,
        channel: "instagram",
        triggeredBy: user._id,
        providerName: "test-malformed",
      }),
    ).rejects.toThrow(/malformed output/i);

    const failed = await AIRun.findOne({ tenantId: tenant._id }).lean();
    expect(failed.status).toBe("failed");
    expect(failed.error.code).toBe("INVALID_OUTPUT");
  });

  it("flags possible_invented_fact for unknown capitalized brand names", async () => {
    const { tenant, user } = await createTenantCtx("invented");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    AIProviderClient.registerProvider("test-invented", {
      name: "test-invented",
      async generate() {
        return {
          output: {
            variants: [
              {
                id: "v1",
                body: "Acme Coffee partners with Mystery Roasters Co!",
                hashtags: [],
                cta: "Visit",
                confidence: 0.6,
              },
            ],
            confidence: 0.6,
            requiredApproval: true,
          },
          usage: { totalTokens: 10 },
          model: "test",
          providerRequestId: "test",
          latencyMs: 0,
        };
      },
    });

    const result = await AISocialContentService.generateSocialContent({
      tenantId: tenant._id,
      channel: "instagram",
      triggeredBy: user._id,
      providerName: "test-invented",
    });
    expect(result.draft.riskFlags).toContain("possible_invented_fact");
    // Soft flag — does not block the run
    expect(result.aiRun.status).toBe("succeeded");
  });

  it("increments aiRuns and aiTokens usage meters on success", async () => {
    const { tenant, user } = await createTenantCtx("metering");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);

    await AISocialContentService.generateSocialContent({
      tenantId: tenant._id,
      channel: "instagram",
      triggeredBy: user._id,
    });

    const meter = await UsageMeter.findOne({ tenantId: tenant._id }).lean();
    expect(meter.aiRuns).toBe(1);
    expect(meter.aiTokens).toBeGreaterThan(0);
  });

  it("enforces tenant isolation across BrandProfile and prompt template", async () => {
    const { tenant: tenantA } = await createTenantCtx("iso-a");
    const { tenant: tenantB, user: userB } = await createTenantCtx("iso-b");
    await seedBrandProfile(tenantA);
    await seedPromptTemplate(tenantA);

    // Tenant B has neither — should not be able to use Tenant A's data.
    await expect(
      AISocialContentService.generateSocialContent({
        tenantId: tenantB._id,
        channel: "instagram",
        triggeredBy: userB._id,
      }),
    ).rejects.toThrow(/brand profile is required/i);
  });
});

describe("AISocialContentService.approve / reject", () => {
  it("approves a pending draft and updates the linked ApprovalRequest", async () => {
    const { tenant, user } = await createTenantCtx("approve");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);
    const result = await AISocialContentService.generateSocialContent({
      tenantId: tenant._id,
      channel: "instagram",
      triggeredBy: user._id,
    });

    const approved = await AISocialContentService.approveDraft({
      tenantId: tenant._id,
      draftId: result.draft._id,
      decidedBy: user._id,
      decisionReason: "Looks great",
    });
    expect(approved.draft.status).toBe("approved");
    const reloadedApproval = await ApprovalRequest.findById(
      result.approvalRequest._id,
    ).lean();
    expect(reloadedApproval.status).toBe("approved");
    expect(String(reloadedApproval.decidedBy)).toBe(String(user._id));
  });

  it("rejects a pending draft with required reason", async () => {
    const { tenant, user } = await createTenantCtx("reject");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);
    const result = await AISocialContentService.generateSocialContent({
      tenantId: tenant._id,
      channel: "instagram",
      triggeredBy: user._id,
    });

    await expect(
      AISocialContentService.rejectDraft({
        tenantId: tenant._id,
        draftId: result.draft._id,
        decidedBy: user._id,
        decisionReason: "",
      }),
    ).rejects.toThrow(/decisionReason is required/i);

    const rejected = await AISocialContentService.rejectDraft({
      tenantId: tenant._id,
      draftId: result.draft._id,
      decidedBy: user._id,
      decisionReason: "Off-brand",
    });
    expect(rejected.draft.status).toBe("rejected");
  });

  it("rejects cross-tenant approval attempts", async () => {
    const { tenant: tenantA, user: userA } = await createTenantCtx("cross-a");
    const { tenant: tenantB, user: userB } = await createTenantCtx("cross-b");
    await seedBrandProfile(tenantA);
    await seedPromptTemplate(tenantA);
    const result = await AISocialContentService.generateSocialContent({
      tenantId: tenantA._id,
      channel: "instagram",
      triggeredBy: userA._id,
    });

    await expect(
      AISocialContentService.approveDraft({
        tenantId: tenantB._id,
        draftId: result.draft._id,
        decidedBy: userB._id,
      }),
    ).rejects.toThrow(/Content draft not found/);
  });
});

describe("AISocialContentService.upsertBrandProfile", () => {
  it("creates and updates a tenant brand profile", async () => {
    const { tenant, user } = await createTenantCtx("brand-upsert");
    const created = await AISocialContentService.upsertBrandProfile({
      tenantId: tenant._id,
      payload: {
        businessName: "Foo",
        description: "Bar",
        industry: "things",
        products: [],
        services: [],
        offers: [],
        locations: [],
        slogans: ["test"],
        audience: {},
        brandVoice: {},
        campaignGoals: [],
        approvedClaims: [],
        forbiddenClaims: [],
        compliance: {},
        defaultChannels: ["instagram"],
        defaultLanguage: "en",
      },
      updatedBy: user._id,
    });
    expect(created.businessName).toBe("Foo");

    const updated = await AISocialContentService.upsertBrandProfile({
      tenantId: tenant._id,
      payload: { businessName: "Foo 2" },
      updatedBy: user._id,
    });
    expect(updated.businessName).toBe("Foo 2");
    expect(updated.description).toBe("Bar"); // existing fields kept
  });
});

describe("ai.draft processor", () => {
  it("rejects payload without tenantId as NonRetryableError", async () => {
    await expect(
      processAiDraft({
        id: "j1",
        name: "social.content.generate",
        attemptsMade: 0,
        data: {},
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("rejects unknown job names", async () => {
    const { tenant } = await createTenantCtx("proc-unknown");
    await expect(
      processAiDraft({
        id: "j2",
        name: "ai.unknown",
        attemptsMade: 0,
        data: { tenantId: String(tenant._id) },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("delegates social.content.generate to the service", async () => {
    const { tenant, user } = await createTenantCtx("proc-happy");
    await seedBrandProfile(tenant);
    await seedPromptTemplate(tenant);
    const result = await processAiDraft({
      id: "j3",
      name: "social.content.generate",
      attemptsMade: 0,
      data: {
        tenantId: String(tenant._id),
        channel: "instagram",
        triggeredBy: String(user._id),
      },
    });
    expect(result.draftId).toBeTruthy();
    expect(result.aiRunId).toBeTruthy();
    expect(result.approvalRequestId).toBeTruthy();
  });

  it("converts AISocialPermanentError into NonRetryableError for BullMQ", async () => {
    const { tenant, user } = await createTenantCtx("proc-perm");
    // No brand profile, no prompt — service throws AISocialPermanentError
    await expect(
      processAiDraft({
        id: "j4",
        name: "social.content.generate",
        attemptsMade: 0,
        data: {
          tenantId: String(tenant._id),
          channel: "instagram",
          triggeredBy: String(user._id),
        },
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
