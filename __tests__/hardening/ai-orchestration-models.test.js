/**
 * Tests for the P7-001 AI orchestration model layer:
 *   1. PromptTemplate — versioning lineage, unique (tenantId, name, version),
 *      tenant isolation, default `requiresApproval: true`, guardrails shape.
 *   2. AIRun — required pinned prompt fields, status enum, confidence bounds,
 *      idempotency uniqueness, tenant isolation, approval/draft/workflow links.
 *   3. BrandProfile — single document per tenant (unique tenantId), approved/
 *      forbidden claim lists, location/product/offer sub-document defaults.
 *   4. ContentDraft — variant id uniqueness, selectedVariantId validation,
 *      idempotency uniqueness, status enum, approval defaults.
 *   5. AuditLog enum — new entityType values are accepted.
 *   6. ApprovalRequest enum — `content_draft` related-entity is accepted.
 *   7. Prompt template seeds — shape, required context, guardrails coverage.
 *
 * Runs against an in-memory Mongo instance — model layer only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let AIRun;
let PromptTemplate;
let BrandProfile;
let ContentDraft;
let ApprovalRequest;
let APPROVAL_RELATED_ENTITY_TYPES;
let AuditLog;
let promptTemplateSeeds;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  AIRun = (await import("../../src/models/AIRun.js")).default;
  PromptTemplate = (await import("../../src/models/PromptTemplate.js")).default;
  BrandProfile = (await import("../../src/models/BrandProfile.js")).default;
  ContentDraft = (await import("../../src/models/ContentDraft.js")).default;
  const approvalMod = await import("../../src/models/ApprovalRequest.js");
  ApprovalRequest = approvalMod.default;
  APPROVAL_RELATED_ENTITY_TYPES = approvalMod.APPROVAL_RELATED_ENTITY_TYPES;
  AuditLog = (await import("../../src/models/AuditLog.js")).default;
  promptTemplateSeeds = await import(
    "../../src/services/ai/aiPromptTemplateSeeds.js"
  );

  await PromptTemplate.syncIndexes();
  await AIRun.syncIndexes();
  await BrandProfile.syncIndexes();
  await ContentDraft.syncIndexes();
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

function newTenantId() {
  return new mongoose.Types.ObjectId();
}

function buildPromptTemplate(overrides = {}) {
  return {
    tenantId: overrides.tenantId || newTenantId(),
    name: overrides.name || "social.caption.generic",
    description: "Generic caption generator",
    category: overrides.category || "social_caption",
    agent: overrides.agent || "social.caption_generator",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "You are a brand-safe caption writer.",
    userPromptTemplate: "Write a caption for {{brand_profile.businessName}}.",
    requiredContext: overrides.requiredContext || ["brand_profile"],
    contextSources: ["brand_profile"],
    guardrails: overrides.guardrails || [
      { id: "no_invented_business_facts", severity: "hard" },
    ],
    ...overrides,
  };
}

function buildAIRun(overrides = {}) {
  return {
    tenantId: overrides.tenantId || newTenantId(),
    agent: overrides.agent || "social.caption_generator",
    promptTemplateName: overrides.promptTemplateName || "social.caption.generic",
    promptTemplateVersion: overrides.promptTemplateVersion ?? 1,
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

function buildContentDraft(overrides = {}) {
  return {
    tenantId: overrides.tenantId || newTenantId(),
    aiRunId: overrides.aiRunId || new mongoose.Types.ObjectId(),
    contentType: overrides.contentType || "social_caption",
    channel: overrides.channel ?? "instagram",
    variants: overrides.variants || [
      {
        id: "v1",
        body: "Discover our new product.",
        hashtags: ["#new"],
        confidence: 0.8,
      },
    ],
    ...overrides,
  };
}

// ── PromptTemplate ───────────────────────────────────────
describe("PromptTemplate — schema and validation", () => {
  it("requires tenantId, name, category, agent", async () => {
    await expect(PromptTemplate.create({})).rejects.toThrow();
    await expect(
      PromptTemplate.create({
        tenantId: newTenantId(),
        name: "",
        category: "social_caption",
        agent: "x",
      }),
    ).rejects.toThrow();
  });

  it("defaults lineageId to its own _id on first version", async () => {
    const tpl = await PromptTemplate.create(buildPromptTemplate());
    expect(tpl.lineageId.toString()).toBe(tpl._id.toString());
    expect(tpl.version).toBe(1);
    expect(tpl.status).toBe("draft");
  });

  it("defaults requiresApproval to true (AI Contract: approval-by-default)", async () => {
    const tpl = await PromptTemplate.create(buildPromptTemplate());
    expect(tpl.requiresApproval).toBe(true);
  });

  it("preserves explicit lineageId across versions", async () => {
    const v1 = await PromptTemplate.create(buildPromptTemplate());
    const v2 = await PromptTemplate.create(
      buildPromptTemplate({
        tenantId: v1.tenantId,
        version: 2,
        lineageId: v1.lineageId,
        previousVersionId: v1._id,
      }),
    );
    expect(v2.lineageId.toString()).toBe(v1.lineageId.toString());
    expect(v2.version).toBe(2);
    expect(v2.previousVersionId.toString()).toBe(v1._id.toString());
  });

  it("rejects duplicate (tenantId, name, version) when not archived", async () => {
    const tenantId = newTenantId();
    await PromptTemplate.create(buildPromptTemplate({ tenantId, version: 1 }));
    await expect(
      PromptTemplate.create(buildPromptTemplate({ tenantId, version: 1 })),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("isolates templates by tenantId — same name/version OK across tenants", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const a = await PromptTemplate.create(
      buildPromptTemplate({ tenantId: tenantA }),
    );
    const b = await PromptTemplate.create(
      buildPromptTemplate({ tenantId: tenantB }),
    );
    expect(a.tenantId.toString()).toBe(tenantA.toString());
    expect(b.tenantId.toString()).toBe(tenantB.toString());

    const onlyA = await PromptTemplate.find({ tenantId: tenantA });
    expect(onlyA).toHaveLength(1);
  });

  it("validates guardrail severity enum", async () => {
    await expect(
      PromptTemplate.create(
        buildPromptTemplate({
          guardrails: [{ id: "x", severity: "invalid" }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects category outside the enum", async () => {
    await expect(
      PromptTemplate.create(
        buildPromptTemplate({ category: "not_a_real_category" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects temperature outside [0, 2]", async () => {
    await expect(
      PromptTemplate.create(buildPromptTemplate({ temperature: 5 })),
    ).rejects.toThrow();
  });
});

// ── AIRun ────────────────────────────────────────────────
describe("AIRun — schema and validation", () => {
  it("requires tenantId, agent, promptTemplateName/Version, model fields", async () => {
    await expect(AIRun.create({})).rejects.toThrow();
    await expect(
      AIRun.create({
        tenantId: newTenantId(),
        agent: "x",
        promptTemplateVersion: 1,
        modelProvider: "anthropic",
        model: "x",
      }),
    ).rejects.toThrow(); // missing promptTemplateName
  });

  it("defaults status to pending and requiresApproval to true", async () => {
    const run = await AIRun.create(buildAIRun());
    expect(run.status).toBe("pending");
    expect(run.requiresApproval).toBe(true);
  });

  it("rejects confidence outside [0, 1]", async () => {
    await expect(
      AIRun.create(buildAIRun({ confidence: 1.5 })),
    ).rejects.toThrow();
    await expect(
      AIRun.create(buildAIRun({ confidence: -0.1 })),
    ).rejects.toThrow();
  });

  it("rejects status outside the enum", async () => {
    await expect(
      AIRun.create(buildAIRun({ status: "weird" })),
    ).rejects.toThrow();
  });

  it("rejects modelProvider outside the enum", async () => {
    await expect(
      AIRun.create(buildAIRun({ modelProvider: "wikipedia" })),
    ).rejects.toThrow();
  });

  it("rejects promptTemplateVersion < 1", async () => {
    await expect(
      AIRun.create(buildAIRun({ promptTemplateVersion: 0 })),
    ).rejects.toThrow();
  });

  it("isolates AI runs by tenantId", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await AIRun.create(buildAIRun({ tenantId: tenantA }));
    await AIRun.create(buildAIRun({ tenantId: tenantB }));
    const onlyA = await AIRun.find({ tenantId: tenantA });
    expect(onlyA).toHaveLength(1);
  });

  it("dedupes per-tenant idempotencyKey", async () => {
    const tenantId = newTenantId();
    await AIRun.create(
      buildAIRun({ tenantId, idempotencyKey: "k:1" }),
    );
    await expect(
      AIRun.create(buildAIRun({ tenantId, idempotencyKey: "k:1" })),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the SAME idempotencyKey across different tenants", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await AIRun.create(
      buildAIRun({ tenantId: tenantA, idempotencyKey: "shared" }),
    );
    await expect(
      AIRun.create(
        buildAIRun({ tenantId: tenantB, idempotencyKey: "shared" }),
      ),
    ).resolves.toBeDefined();
  });

  it("allows multiple AIRuns with null idempotencyKey for the same tenant", async () => {
    const tenantId = newTenantId();
    await AIRun.create(buildAIRun({ tenantId }));
    await expect(AIRun.create(buildAIRun({ tenantId }))).resolves.toBeDefined();
  });

  it("persists usage/cost defaults at zero", async () => {
    const run = await AIRun.create(buildAIRun());
    expect(run.usage.promptTokens).toBe(0);
    expect(run.usage.completionTokens).toBe(0);
    expect(run.usage.totalTokens).toBe(0);
    expect(run.usage.costMicroUsd).toBe(0);
  });

  it("captures workflow correlation fields and approval/draft links", async () => {
    const tenantId = newTenantId();
    const workflowRunId = new mongoose.Types.ObjectId();
    const approvalRequestId = new mongoose.Types.ObjectId();
    const contentDraftId = new mongoose.Types.ObjectId();
    const run = await AIRun.create(
      buildAIRun({
        tenantId,
        workflowRunId,
        workflowNodeId: "ai_node_1",
        approvalRequestId,
        contentDraftId,
        contextSources: [
          { type: "brand_profile", refId: new mongoose.Types.ObjectId(), label: "Brand", approved: true },
          { type: "trend_input", refId: null, label: "Trend X", approved: true },
        ],
      }),
    );
    expect(run.workflowRunId.toString()).toBe(workflowRunId.toString());
    expect(run.workflowNodeId).toBe("ai_node_1");
    expect(run.approvalRequestId.toString()).toBe(approvalRequestId.toString());
    expect(run.contentDraftId.toString()).toBe(contentDraftId.toString());
    expect(run.contextSources).toHaveLength(2);
  });
});

// ── BrandProfile ─────────────────────────────────────────
describe("BrandProfile — schema and validation", () => {
  it("enforces a single profile per tenant", async () => {
    const tenantId = newTenantId();
    await BrandProfile.create({ tenantId });
    await expect(BrandProfile.create({ tenantId })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("isolates profiles by tenantId", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await BrandProfile.create({ tenantId: tenantA, businessName: "Acme" });
    await BrandProfile.create({ tenantId: tenantB, businessName: "Globex" });
    const a = await BrandProfile.findOne({ tenantId: tenantA });
    expect(a.businessName).toBe("Acme");
  });

  it("stores approved and forbidden claim lists", async () => {
    const tenantId = newTenantId();
    const profile = await BrandProfile.create({
      tenantId,
      approvedClaims: ["Family-owned since 1998", "Free shipping over $50"],
      forbiddenClaims: ["Best in the world", "Cures cancer"],
    });
    expect(profile.approvedClaims).toHaveLength(2);
    expect(profile.forbiddenClaims).toContain("Cures cancer");
  });

  it("stores products, services, offers, locations, brand voice, audience", async () => {
    const tenantId = newTenantId();
    const profile = await BrandProfile.create({
      tenantId,
      businessName: "Acme",
      description: "A test business.",
      products: [{ name: "Widget", description: "Best widget." }],
      services: [{ name: "Consulting" }],
      offers: [{ name: "Spring sale", discount: "20% off" }],
      locations: [
        { name: "HQ", region: "TX", country: "US", language: "en" },
      ],
      slogans: ["The widget that works"],
      audience: {
        demographics: "SMB owners",
        painPoints: ["Slow tools"],
        goals: ["Save time"],
      },
      brandVoice: {
        tone: "Friendly",
        doNotUse: ["disrupt"],
      },
      campaignGoals: [{ name: "Drive Q3 trials", kpi: "trials_started" }],
    });
    expect(profile.products[0].name).toBe("Widget");
    expect(profile.services[0].name).toBe("Consulting");
    expect(profile.offers[0].discount).toBe("20% off");
    expect(profile.locations[0].country).toBe("US");
    expect(profile.audience.painPoints[0]).toBe("Slow tools");
    expect(profile.brandVoice.doNotUse).toContain("disrupt");
    expect(profile.campaignGoals[0].kpi).toBe("trials_started");
  });

  it("rejects defaultChannels values outside the allowed set", async () => {
    await expect(
      BrandProfile.create({
        tenantId: newTenantId(),
        defaultChannels: ["myspace"],
      }),
    ).rejects.toThrow();
  });
});

// ── ContentDraft ─────────────────────────────────────────
describe("ContentDraft — schema and validation", () => {
  it("requires tenantId, aiRunId, contentType", async () => {
    await expect(ContentDraft.create({})).rejects.toThrow();
  });

  it("defaults status to draft and requiresApproval to true", async () => {
    const draft = await ContentDraft.create(buildContentDraft());
    expect(draft.status).toBe("draft");
    expect(draft.requiresApproval).toBe(true);
  });

  it("rejects duplicate variant ids", async () => {
    await expect(
      ContentDraft.create(
        buildContentDraft({
          variants: [
            { id: "v1", body: "a" },
            { id: "v1", body: "b" },
          ],
        }),
      ),
    ).rejects.toThrow(/unique within a draft/i);
  });

  it("rejects selectedVariantId that does not exist in variants", async () => {
    await expect(
      ContentDraft.create(
        buildContentDraft({
          selectedVariantId: "missing",
          variants: [{ id: "v1", body: "a" }],
        }),
      ),
    ).rejects.toThrow(/does not match any variants/i);
  });

  it("accepts a valid selectedVariantId", async () => {
    const draft = await ContentDraft.create(
      buildContentDraft({
        selectedVariantId: "v1",
        variants: [
          { id: "v1", body: "a" },
          { id: "v2", body: "b" },
        ],
      }),
    );
    expect(draft.selectedVariantId).toBe("v1");
  });

  it("rejects status outside the enum", async () => {
    await expect(
      ContentDraft.create(buildContentDraft({ status: "totally_published" })),
    ).rejects.toThrow();
  });

  it("rejects channel outside the enum", async () => {
    await expect(
      ContentDraft.create(buildContentDraft({ channel: "myspace" })),
    ).rejects.toThrow();
  });

  it("isolates drafts by tenantId", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await ContentDraft.create(buildContentDraft({ tenantId: tenantA }));
    await ContentDraft.create(buildContentDraft({ tenantId: tenantB }));
    const onlyA = await ContentDraft.find({ tenantId: tenantA });
    expect(onlyA).toHaveLength(1);
  });

  it("dedupes per-tenant idempotencyKey", async () => {
    const tenantId = newTenantId();
    await ContentDraft.create(
      buildContentDraft({ tenantId, idempotencyKey: "draft:1" }),
    );
    await expect(
      ContentDraft.create(
        buildContentDraft({ tenantId, idempotencyKey: "draft:1" }),
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the same idempotencyKey across tenants", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await ContentDraft.create(
      buildContentDraft({ tenantId: tenantA, idempotencyKey: "shared" }),
    );
    await expect(
      ContentDraft.create(
        buildContentDraft({ tenantId: tenantB, idempotencyKey: "shared" }),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects variant confidence outside [0, 1]", async () => {
    await expect(
      ContentDraft.create(
        buildContentDraft({
          variants: [{ id: "v1", body: "a", confidence: 9 }],
        }),
      ),
    ).rejects.toThrow();
  });
});

// ── AuditLog enum extension ──────────────────────────────
describe("AuditLog — extended entityType enum", () => {
  it("accepts ai_run, prompt_template, brand_profile, content_draft", async () => {
    const tenantId = newTenantId();
    for (const entityType of [
      "ai_run",
      "prompt_template",
      "brand_profile",
      "content_draft",
    ]) {
      const log = await AuditLog.create({
        tenantId,
        action: "ai.run_started",
        entityType,
        entityId: new mongoose.Types.ObjectId(),
        description: `audit for ${entityType}`,
      });
      expect(log.entityType).toBe(entityType);
    }
  });
});

// ── ApprovalRequest enum extension ───────────────────────
describe("ApprovalRequest — accepts content_draft related entity", () => {
  it("includes content_draft in APPROVAL_RELATED_ENTITY_TYPES", () => {
    expect(APPROVAL_RELATED_ENTITY_TYPES).toContain("content_draft");
    expect(APPROVAL_RELATED_ENTITY_TYPES).toContain("ai_run");
  });

  it("accepts a content_draft approval request", async () => {
    const tenantId = newTenantId();
    const draftId = new mongoose.Types.ObjectId();
    const approval = await ApprovalRequest.create({
      tenantId,
      type: "ai.action",
      relatedEntityType: "content_draft",
      relatedEntityId: draftId,
      summary: "Approve generated caption",
      aiGenerated: true,
      confidence: 0.82,
    });
    expect(approval.relatedEntityType).toBe("content_draft");
    expect(approval.confidence).toBe(0.82);
  });
});

// ── Prompt template seeds ────────────────────────────────
describe("aiPromptTemplateSeeds — bootstrap shape", () => {
  it("returns the required social and review-reply templates", () => {
    const seeds = promptTemplateSeeds.getPromptTemplateSeeds();
    const names = seeds.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "gmb.review.reply",
        "social.calendar.idea",
        "social.caption.generic",
        "social.hashtag.set",
        "social.local_business.post",
        "social.offer.post",
        "social.product_launch.post",
      ].sort(),
    );
  });

  it("every seed has guardrails, requires approval, and lists brand_profile context", () => {
    const seeds = promptTemplateSeeds.getPromptTemplateSeeds();
    for (const seed of seeds) {
      expect(seed.requiresApproval).toBe(true);
      expect(seed.guardrails.length).toBeGreaterThan(0);
      expect(seed.requiredContext).toContain("brand_profile");
      expect(seed.contextSources).toContain("brand_profile");
      expect(seed.version).toBe(1);
    }
  });

  it("every seed installs the no-invented-facts and no-forbidden-claims guardrails", () => {
    const seeds = promptTemplateSeeds.getPromptTemplateSeeds();
    for (const seed of seeds) {
      const ids = seed.guardrails.map((g) => g.id);
      expect(ids).toContain("no_invented_business_facts");
      expect(ids).toContain("no_forbidden_claims");
    }
  });

  it("seeds are persistable as PromptTemplate documents per tenant", async () => {
    const tenantId = newTenantId();
    const seeds = promptTemplateSeeds.getPromptTemplateSeeds();
    const created = await PromptTemplate.insertMany(
      seeds.map((s) => ({ ...s, tenantId })),
    );
    expect(created).toHaveLength(seeds.length);
    for (const tpl of created) {
      expect(tpl.tenantId.toString()).toBe(tenantId.toString());
      expect(tpl.lineageId.toString()).toBe(tpl._id.toString());
      expect(tpl.requiresApproval).toBe(true);
    }
  });

  it("seed copies are independent — mutating one does not affect the next call", () => {
    const a = promptTemplateSeeds.getPromptTemplateSeeds();
    a[0].guardrails.push({ id: "mutated", severity: "soft" });
    const b = promptTemplateSeeds.getPromptTemplateSeeds();
    expect(b[0].guardrails.find((g) => g.id === "mutated")).toBeUndefined();
  });
});
