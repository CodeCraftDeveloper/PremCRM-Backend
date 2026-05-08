/**
 * AI Social Content Generator (P7-002).
 *
 * Generates captions, hashtags, CTAs, and content-calendar suggestions
 * for social channels (Facebook / Instagram / etc.) from a tenant's
 * `BrandProfile`, optional `CampaignGoal`, optional `TrendInput[]`, and
 * approved CRM/audience hints.
 *
 * AI Contract obligations enforced here:
 *
 *   1. Tenant isolation — every read/write is `tenantId`-scoped.
 *   2. No invented business facts — output text is screened against the
 *      brand profile's approved facts; mentions of unknown product /
 *      service / location / award names cause the run to be marked
 *      `blocked_by_guardrail` and the draft to inherit a hard risk flag.
 *   3. No forbidden claims — strings listed in
 *      `brand_profile.forbiddenClaims` always block the run.
 *   4. Approval-by-default — every produced `ContentDraft` carries
 *      `requiresApproval=true` and a paired pending `ApprovalRequest`
 *      of type `ai.action`. AI-generated drafts can NEVER auto-approve
 *      from this service; tenant auto-action policy is a future slice.
 *   5. Usage metering — `aiRuns` (+1) and `aiTokens` (+totalTokens) are
 *      incremented after a successful provider call.
 *   6. Audit log — `ai.social_draft_created` on success and
 *      `ai.social_draft_failed` on permanent failure.
 *
 * The service is provider-agnostic — see `aiProviderClient.js` for the
 * mock provider used in tests and offline development.
 */

import crypto from "crypto";
import AIRun from "../../models/AIRun.js";
import ApprovalRequest from "../../models/ApprovalRequest.js";
import AuditLog from "../../models/AuditLog.js";
import BrandProfile from "../../models/BrandProfile.js";
import ContentDraft from "../../models/ContentDraft.js";
import PromptTemplate from "../../models/PromptTemplate.js";
import { ApiError } from "../../utils/apiResponse.js";
import logger from "../../utils/logger.js";
import { incrementUsage } from "../usageMeterService.js";
import {
  AIProviderPermanentError,
  AIProviderTransientError,
  AIProviderClient,
} from "./aiProviderClient.js";

// ── Domain errors ───────────────────────────────────────────────────
//
// Permanent: validation/policy/structural — the orchestration layer maps
// these onto NonRetryableError when the call is queued.
//
// Transient: model/provider hiccup — the orchestration layer lets these
// bubble so BullMQ retries under the `ai.draft` policy (3 attempts).

export class AISocialPermanentError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "AISocialPermanentError";
    this.permanent = true;
    this.code = code;
    this.status = status;
  }
}

export class AISocialTransientError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "AISocialTransientError";
    this.permanent = false;
    this.code = code;
    this.status = status;
  }
}

// ── Internal helpers ────────────────────────────────────────────────

const SOCIAL_CHANNELS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "x",
  "youtube",
  "tiktok",
  "blog",
  "email",
  "whatsapp",
  "gmb",
  "internal",
]);

const CONTENT_TYPE_BY_AGENT = Object.freeze({
  "social.caption_generator": "social_caption",
  "social.hashtag_generator": "social_hashtag_set",
  "social.calendar_planner": "social_calendar_idea",
  "social.product_launch_generator": "social_product_launch",
  "social.offer_generator": "social_offer",
  "social.local_business_generator": "social_local_business",
});

const DEFAULT_AGENT = "social.caption_generator";

function genIdempotencyKey(seed = "") {
  if (seed) {
    return crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 32);
  }
  return crypto.randomBytes(16).toString("hex");
}

async function loadBrandProfile(tenantId) {
  const brand = await BrandProfile.findOne({ tenantId }).lean();
  if (!brand) {
    throw new AISocialPermanentError(
      "Tenant brand profile is required before generating social content.",
      { code: "BRAND_PROFILE_MISSING" },
    );
  }
  return brand;
}

async function resolvePromptTemplate({ tenantId, agent }) {
  // Pick the active template for this agent, highest version. The orchestrator
  // pins (id, version) onto the AIRun so later edits never affect this run.
  const template = await PromptTemplate.findOne({
    tenantId,
    agent,
    status: "active",
    archivedAt: null,
  })
    .sort({ version: -1 })
    .lean();
  if (!template) {
    throw new AISocialPermanentError(
      `No active prompt template found for agent "${agent}".`,
      { code: "PROMPT_TEMPLATE_MISSING" },
    );
  }
  return template;
}

function selectActiveOffer(offers, now = new Date()) {
  if (!Array.isArray(offers) || offers.length === 0) return null;
  return (
    offers.find((o) => {
      const startsOk = !o.startsAt || new Date(o.startsAt) <= now;
      const endsOk = !o.endsAt || new Date(o.endsAt) >= now;
      return startsOk && endsOk;
    }) || null
  );
}

/**
 * Build the prompt input the provider sees. The input is purely derived
 * from tenant-approved data — no cross-tenant data, no env values, no
 * hard-coded business facts. Trend inputs are passed separately and
 * flagged so the model treats them as inspiration, not as facts.
 */
function buildContextInput({
  brand,
  channel,
  postFormat,
  campaignGoal,
  audienceHint,
  productName,
  locationName,
  trendInputs,
}) {
  const product = productName
    ? brand.products.find((p) => p.name === productName) || null
    : null;
  const location = locationName
    ? brand.locations.find((l) => l.name === locationName) || null
    : brand.locations?.[0] || null;
  const offer = selectActiveOffer(brand.offers);
  const campaign = campaignGoal
    ? brand.campaignGoals.find((c) => c.name === campaignGoal) ||
      { name: campaignGoal }
    : brand.campaignGoals?.[0] || null;

  return {
    brand_profile: {
      businessName: brand.businessName,
      description: brand.description,
      industry: brand.industry,
      products: brand.products,
      services: brand.services,
      offers: brand.offers,
      slogans: brand.slogans,
      audience: brand.audience,
      brandVoice: brand.brandVoice,
      locations: brand.locations,
      defaultChannels: brand.defaultChannels,
      defaultLanguage: brand.defaultLanguage,
    },
    channel,
    post_format: postFormat,
    campaign_goal: campaign,
    audience_hint: audienceHint || null,
    offer,
    product,
    location,
    trend_inputs: Array.isArray(trendInputs)
      ? trendInputs.filter((t) => t && t.approved !== false)
      : [],
  };
}

/**
 * Collect the literal "approved" string surface for guardrail screening.
 * Anything from this set may appear verbatim in output; anything else
 * detected via the heuristic in `findInventedClaims` is flagged.
 */
function collectApprovedSurface(brand) {
  const out = [];
  if (brand.businessName) out.push(brand.businessName);
  if (brand.description) out.push(brand.description);
  if (Array.isArray(brand.slogans)) out.push(...brand.slogans);
  if (Array.isArray(brand.approvedClaims)) out.push(...brand.approvedClaims);
  if (Array.isArray(brand.products)) {
    for (const p of brand.products) {
      if (p?.name) out.push(p.name);
      if (p?.description) out.push(p.description);
    }
  }
  if (Array.isArray(brand.services)) {
    for (const s of brand.services) {
      if (s?.name) out.push(s.name);
      if (s?.description) out.push(s.description);
    }
  }
  if (Array.isArray(brand.offers)) {
    for (const o of brand.offers) {
      if (o?.name) out.push(o.name);
      if (o?.description) out.push(o.description);
    }
  }
  if (Array.isArray(brand.locations)) {
    for (const l of brand.locations) {
      if (l?.name) out.push(l.name);
      if (l?.region) out.push(l.region);
      if (l?.country) out.push(l.country);
    }
  }
  if (brand.brandVoice?.vocabulary) out.push(...brand.brandVoice.vocabulary);
  return out.map((s) => String(s).toLowerCase()).filter(Boolean);
}

function findForbiddenClaims(text, forbiddenClaims) {
  if (!text || !Array.isArray(forbiddenClaims) || forbiddenClaims.length === 0) {
    return [];
  }
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const phrase of forbiddenClaims) {
    if (!phrase) continue;
    if (lower.includes(String(phrase).toLowerCase())) {
      hits.push(String(phrase));
    }
  }
  return hits;
}

/**
 * Guardrail heuristic that flags potentially-invented business facts.
 *
 * Strategy:
 *   - Find capitalized multi-word phrases (`Foo Bar`, `Acme Pro Plus`).
 *   - Treat them as "claim candidates".
 *   - Anything not present in the approved surface is flagged.
 *
 * The heuristic is conservative on purpose — false positives flag risk
 * for human review rather than auto-blocking. Only the explicit
 * `forbiddenClaims` list and the regulated-phrase list cause hard blocks.
 */
function findInventedClaims(text, approvedSurface) {
  if (!text) return [];
  const candidates = String(text).match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,3}\b/g) || [];
  const lowerSurface = approvedSurface; // already lowercased
  const hits = new Set();
  for (const candidate of candidates) {
    const lc = candidate.toLowerCase();
    if (lowerSurface.some((approved) => approved.includes(lc) || lc.includes(approved))) {
      continue;
    }
    hits.add(candidate);
  }
  return Array.from(hits);
}

const REGULATED_PATTERNS = [
  /\bguarantee[ds]?\b/i,
  /\bclinically proven\b/i,
  /\bfda[- ]approved\b/i,
  /\bmedical(ly)? cur[ed]+\b/i,
  /\brisk[- ]?free investment\b/i,
  /\bdouble your (money|investment)\b/i,
];

function findRegulatedClaims(text, compliance = {}) {
  if (!text) return [];
  const hits = [];
  for (const re of REGULATED_PATTERNS) {
    if (re.test(text)) {
      hits.push(re.toString());
    }
  }
  // Compliance flags allow specific categories. If the tenant has not
  // explicitly opted in, regulated phrasing is a hard block.
  if (compliance?.medical && hits.some((h) => /clinic|fda|medical/i.test(h))) {
    return hits.filter((h) => !/clinic|fda|medical/i.test(h));
  }
  if (compliance?.financial && hits.some((h) => /investment|money/i.test(h))) {
    return hits.filter((h) => !/investment|money/i.test(h));
  }
  return hits;
}

function aggregateConfidence(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  let max = 0;
  let any = false;
  for (const v of variants) {
    if (typeof v.confidence === "number") {
      any = true;
      if (v.confidence > max) max = v.confidence;
    }
  }
  return any ? max : null;
}

function aggregateRiskFlags(variants) {
  const flags = new Set();
  for (const v of variants || []) {
    for (const flag of v.riskFlags || []) flags.add(flag);
  }
  return Array.from(flags);
}

// ── Public service surface ──────────────────────────────────────────

async function generateSocialContent({
  tenantId,
  channel,
  postFormat = null,
  campaignGoal = null,
  audienceHint = null,
  productName = null,
  locationName = null,
  trendInputs = [],
  agent = DEFAULT_AGENT,
  triggeredBy = null,
  workflowRunId = null,
  workflowNodeId = null,
  idempotencyKey = null,
  providerName = null,
  modelOverride = null,
  approvalRequest = true,
  relatedEntityType = null,
  relatedEntityId = null,
  correlationId = null,
}) {
  if (!tenantId) {
    throw new AISocialPermanentError("tenantId is required");
  }
  if (channel && !SOCIAL_CHANNELS.has(channel)) {
    throw new AISocialPermanentError(
      `channel "${channel}" is not a supported social channel`,
      { code: "INVALID_CHANNEL" },
    );
  }

  const contentType = CONTENT_TYPE_BY_AGENT[agent] || "social_caption";
  const brand = await loadBrandProfile(tenantId);
  const template = await resolvePromptTemplate({ tenantId, agent });

  const resolvedChannel =
    channel || (brand.defaultChannels && brand.defaultChannels[0]) || null;

  const input = buildContextInput({
    brand,
    channel: resolvedChannel,
    postFormat,
    campaignGoal,
    audienceHint,
    productName,
    locationName,
    trendInputs,
  });

  const contextSources = [
    { type: "brand_profile", refId: brand._id, label: brand.businessName },
  ];
  if (input.campaign_goal) {
    contextSources.push({
      type: "campaign_goal",
      label: input.campaign_goal.name || String(input.campaign_goal),
    });
  }
  if (input.offer) {
    contextSources.push({ type: "offer", label: input.offer.name });
  }
  if (input.product) {
    contextSources.push({ type: "product", label: input.product.name });
  }
  if (Array.isArray(input.trend_inputs)) {
    for (const t of input.trend_inputs) {
      contextSources.push({
        type: "trend_input",
        label: t.title || t.topic || "(untitled trend)",
        approved: t.approved !== false,
      });
    }
  }

  const runIdempotencyKey =
    idempotencyKey ||
    genIdempotencyKey(
      `${tenantId}:${agent}:${resolvedChannel}:${productName || ""}:${campaignGoal || ""}:${Date.now()}`,
    );

  // ── Persist the AIRun in `running` state BEFORE the provider call so the
  //    audit trail captures the attempt even if the provider throws. ────
  const aiRun = await AIRun.create({
    tenantId,
    agent,
    promptTemplateId: template._id,
    promptTemplateName: template.name,
    promptTemplateVersion: template.version,
    promptTemplateLineageId: template.lineageId || template._id,
    modelProvider: template.modelProvider || "anthropic",
    model: modelOverride || template.model || "default",
    status: "running",
    input: { agent, resolvedChannel, postFormat, campaignGoal, productName, locationName, trendCount: input.trend_inputs.length },
    contextSources,
    requiresApproval: template.requiresApproval !== false,
    workflowRunId,
    workflowNodeId,
    correlationId,
    idempotencyKey: runIdempotencyKey,
    triggeredBy,
    startedAt: new Date(),
  });

  let providerResult;
  try {
    const provider = AIProviderClient.getProvider(providerName || undefined);
    providerResult = await provider.generate({
      system: template.systemPrompt || "",
      user: template.userPromptTemplate || "",
      input,
      model: modelOverride || template.model || AIProviderClient.defaultModel(),
      maxTokens: template.maxTokens,
      temperature: template.temperature,
    });
  } catch (err) {
    const finishedAt = new Date();
    if (err instanceof AIProviderPermanentError) {
      await AIRun.findByIdAndUpdate(aiRun._id, {
        status: "failed",
        finishedAt,
        error: { message: err.message, code: err.code, nonRetryable: true },
      });
      AuditLog.record({
        tenantId,
        userId: triggeredBy,
        action: "ai.social_draft_failed",
        entityType: "ai_run",
        entityId: aiRun._id,
        description: `Provider permanent error: ${err.message}`,
        metadata: { agent, code: err.code, status: err.status },
      });
      throw new AISocialPermanentError(err.message, { code: err.code });
    }
    if (err instanceof AIProviderTransientError) {
      await AIRun.findByIdAndUpdate(aiRun._id, {
        status: "failed",
        finishedAt,
        error: { message: err.message, code: err.code, nonRetryable: false },
      });
      throw new AISocialTransientError(err.message, { code: err.code });
    }
    // Anything else is treated as transient — the orchestrator decides.
    await AIRun.findByIdAndUpdate(aiRun._id, {
      status: "failed",
      finishedAt,
      error: { message: err.message, code: err.code || null, nonRetryable: false },
    });
    throw new AISocialTransientError(err.message);
  }

  // ── Validate output structure ──────────────────────────────────────
  const output = providerResult?.output || {};
  if (!output || !Array.isArray(output.variants) || output.variants.length === 0) {
    const finishedAt = new Date();
    await AIRun.findByIdAndUpdate(aiRun._id, {
      status: "failed",
      finishedAt,
      output,
      error: {
        message: "Provider returned no variants",
        code: "INVALID_OUTPUT",
        nonRetryable: true,
      },
    });
    AuditLog.record({
      tenantId,
      userId: triggeredBy,
      action: "ai.social_draft_failed",
      entityType: "ai_run",
      entityId: aiRun._id,
      description: "Structured output missing variants",
      metadata: { agent },
    });
    throw new AISocialPermanentError(
      "AI provider returned malformed output (no variants)",
      { code: "INVALID_OUTPUT" },
    );
  }

  // ── Guardrails ─────────────────────────────────────────────────────
  const approvedSurface = collectApprovedSurface(brand);
  const screenedVariants = [];
  let guardrailBlocked = false;
  let guardrailReason = null;

  for (const raw of output.variants) {
    const body = String(raw.body || "").trim();
    const cta = String(raw.cta || "").trim();
    const combined = [body, cta, ...(raw.hashtags || [])].join(" \n");

    const forbiddenHits = findForbiddenClaims(combined, brand.forbiddenClaims);
    const regulatedHits = findRegulatedClaims(combined, brand.compliance || {});
    const inventedHits = findInventedClaims(combined, approvedSurface);

    const variantRiskFlags = [...(raw.riskFlags || [])];
    if (forbiddenHits.length) variantRiskFlags.push("forbidden_claim");
    if (regulatedHits.length) variantRiskFlags.push("regulated_claim");
    if (inventedHits.length) variantRiskFlags.push("possible_invented_fact");

    if (forbiddenHits.length) {
      guardrailBlocked = true;
      guardrailReason = `forbidden phrase: ${forbiddenHits[0]}`;
    }
    if (regulatedHits.length) {
      guardrailBlocked = true;
      guardrailReason =
        guardrailReason || `regulated phrasing detected: ${regulatedHits[0]}`;
    }

    screenedVariants.push({
      id: raw.id || `v${screenedVariants.length + 1}`,
      body,
      title: raw.title || null,
      hashtags: Array.isArray(raw.hashtags)
        ? raw.hashtags.map((h) => String(h).slice(0, 64)).filter(Boolean)
        : [],
      cta: cta || null,
      postFormat: raw.postFormat || postFormat || null,
      mediaSuggestions: Array.isArray(raw.mediaSuggestions)
        ? raw.mediaSuggestions
        : [],
      scheduledAtSuggestion: raw.scheduledAtSuggestion || null,
      rationale: raw.rationale || null,
      confidence:
        typeof raw.confidence === "number" ? raw.confidence : null,
      riskFlags: Array.from(new Set(variantRiskFlags)),
    });
  }

  const aggregateConf =
    typeof output.confidence === "number"
      ? output.confidence
      : aggregateConfidence(screenedVariants);
  const aggregateRisk = aggregateRiskFlags(screenedVariants);

  // ── Hard guardrail block: short-circuit before persisting a draft. ─
  if (guardrailBlocked) {
    const finishedAt = new Date();
    await AIRun.findByIdAndUpdate(aiRun._id, {
      status: "blocked_by_guardrail",
      finishedAt,
      output,
      confidence: aggregateConf,
      riskFlags: aggregateRisk,
      usage: providerResult.usage || {},
      providerRequestId: providerResult.providerRequestId || null,
      guardrailBlock: {
        guardrailId: "social_content_guardrail",
        reason: guardrailReason || "guardrail blocked output",
      },
    });
    // Still meter the call — tokens were consumed by the provider.
    if (providerResult?.usage) {
      try {
        await incrementUsage(tenantId, "aiRuns", 1);
        if (providerResult.usage.totalTokens > 0) {
          await incrementUsage(
            tenantId,
            "aiTokens",
            providerResult.usage.totalTokens,
          );
        }
      } catch (e) {
        logger.warn(`[ai-social] usage meter failed: ${e.message}`);
      }
    }
    AuditLog.record({
      tenantId,
      userId: triggeredBy,
      action: "ai.social_draft_blocked",
      entityType: "ai_run",
      entityId: aiRun._id,
      description: guardrailReason || "guardrail blocked output",
      metadata: { agent, riskFlags: aggregateRisk },
    });
    throw new AISocialPermanentError(
      `AI guardrail blocked draft: ${guardrailReason}`,
      { code: "GUARDRAIL_BLOCKED" },
    );
  }

  // ── Persist ContentDraft ───────────────────────────────────────────
  const selectedVariantId = screenedVariants[0]?.id || null;
  const draft = await ContentDraft.create({
    tenantId,
    aiRunId: aiRun._id,
    promptTemplateId: template._id,
    promptTemplateName: template.name,
    promptTemplateVersion: template.version,
    contentType,
    channel: resolvedChannel || null,
    agent,
    variants: screenedVariants,
    selectedVariantId,
    contextSources,
    confidence: aggregateConf,
    riskFlags: aggregateRisk,
    requiresApproval: true,
    status: approvalRequest ? "pending_approval" : "draft",
    relatedEntityType: relatedEntityType || null,
    relatedEntityId: relatedEntityId || null,
    idempotencyKey: runIdempotencyKey,
    metadata: {
      campaignGoal: campaignGoal || null,
      productName: productName || null,
      locationName: locationName || null,
      trendInputCount: input.trend_inputs.length,
    },
    createdBy: triggeredBy,
    submittedForApprovalAt: approvalRequest ? new Date() : null,
  });

  let approval = null;
  if (approvalRequest) {
    approval = await ApprovalRequest.create({
      tenantId,
      type: "ai.action",
      status: "pending",
      relatedEntityType: "content_draft",
      relatedEntityId: draft._id,
      summary: String(screenedVariants[0]?.body || "").slice(0, 2000),
      metadata: {
        agent,
        channel: resolvedChannel,
        contentType,
        riskFlags: aggregateRisk,
      },
      aiGenerated: true,
      aiRunId: aiRun._id,
      confidence: aggregateConf,
      requestedBy: triggeredBy,
    });
    draft.approvalRequestId = approval._id;
    await draft.save();
  }

  // ── Finalise the AIRun ─────────────────────────────────────────────
  await AIRun.findByIdAndUpdate(aiRun._id, {
    status: "succeeded",
    finishedAt: new Date(),
    output,
    confidence: aggregateConf,
    riskFlags: aggregateRisk,
    usage: providerResult.usage || {},
    providerRequestId: providerResult.providerRequestId || null,
    contentDraftId: draft._id,
    approvalRequestId: approval?._id || null,
  });

  // ── Usage metering (after success) ─────────────────────────────────
  try {
    await incrementUsage(tenantId, "aiRuns", 1);
    if (providerResult.usage?.totalTokens > 0) {
      await incrementUsage(
        tenantId,
        "aiTokens",
        providerResult.usage.totalTokens,
      );
    }
  } catch (e) {
    // Usage meter failures must never abort the draft — log + continue.
    logger.warn(`[ai-social] usage meter failed: ${e.message}`);
  }

  // ── Audit log ──────────────────────────────────────────────────────
  AuditLog.record({
    tenantId,
    userId: triggeredBy,
    action: "ai.social_draft_created",
    entityType: "content_draft",
    entityId: draft._id,
    description: `AI social draft created (${agent}, channel=${resolvedChannel || "default"})`,
    metadata: {
      agent,
      contentType,
      channel: resolvedChannel,
      aiRunId: String(aiRun._id),
      approvalRequestId: approval ? String(approval._id) : null,
      confidence: aggregateConf,
      riskFlags: aggregateRisk,
      tokens: providerResult.usage?.totalTokens ?? 0,
    },
  });

  // Return fresh, lean shapes suited for HTTP response / queue dispatch.
  return {
    aiRun: await AIRun.findById(aiRun._id).lean(),
    draft: await ContentDraft.findById(draft._id).lean(),
    approvalRequest: approval ? await ApprovalRequest.findById(approval._id).lean() : null,
    usage: providerResult.usage || null,
  };
}

// ── Approval helpers ────────────────────────────────────────────────

async function approveDraft({ tenantId, draftId, decidedBy, decisionReason = null }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!draftId) throw ApiError.badRequest("draftId is required");

  const draft = await ContentDraft.findOne({ _id: draftId, tenantId });
  if (!draft) throw ApiError.notFound("Content draft not found");

  if (draft.status === "approved") {
    return { draft: draft.toObject(), alreadyApproved: true };
  }
  if (!["draft", "pending_approval"].includes(draft.status)) {
    throw ApiError.badRequest(
      `Cannot approve draft in status "${draft.status}"`,
    );
  }

  if (draft.approvalRequestId) {
    const approval = await ApprovalRequest.findOne({
      _id: draft.approvalRequestId,
      tenantId,
    });
    if (approval && approval.status === "pending") {
      approval.status = "approved";
      approval.decidedBy = decidedBy || null;
      approval.decidedAt = new Date();
      approval.decisionReason = decisionReason || null;
      await approval.save();
    }
  }

  draft.status = "approved";
  draft.decidedAt = new Date();
  await draft.save();

  AuditLog.record({
    tenantId,
    userId: decidedBy,
    action: "ai.social_draft_approved",
    entityType: "content_draft",
    entityId: draft._id,
    description: "AI social draft approved",
    metadata: { agent: draft.agent, channel: draft.channel },
  });

  return { draft: draft.toObject(), alreadyApproved: false };
}

async function rejectDraft({ tenantId, draftId, decidedBy, decisionReason }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!draftId) throw ApiError.badRequest("draftId is required");
  if (!decisionReason || String(decisionReason).trim().length === 0) {
    throw ApiError.badRequest("decisionReason is required when rejecting");
  }

  const draft = await ContentDraft.findOne({ _id: draftId, tenantId });
  if (!draft) throw ApiError.notFound("Content draft not found");

  if (draft.status === "rejected") {
    return { draft: draft.toObject(), alreadyRejected: true };
  }
  if (!["draft", "pending_approval"].includes(draft.status)) {
    throw ApiError.badRequest(
      `Cannot reject draft in status "${draft.status}"`,
    );
  }

  if (draft.approvalRequestId) {
    const approval = await ApprovalRequest.findOne({
      _id: draft.approvalRequestId,
      tenantId,
    });
    if (approval && approval.status === "pending") {
      approval.status = "rejected";
      approval.decidedBy = decidedBy || null;
      approval.decidedAt = new Date();
      approval.decisionReason = String(decisionReason).slice(0, 1000);
      await approval.save();
    }
  }

  draft.status = "rejected";
  draft.decidedAt = new Date();
  await draft.save();

  AuditLog.record({
    tenantId,
    userId: decidedBy,
    action: "ai.social_draft_rejected",
    entityType: "content_draft",
    entityId: draft._id,
    description: `AI social draft rejected: ${String(decisionReason).slice(0, 200)}`,
    metadata: { agent: draft.agent, channel: draft.channel },
  });

  return { draft: draft.toObject(), alreadyRejected: false };
}

// ── Brand profile helpers (admin upsert) ────────────────────────────

async function getBrandProfile(tenantId) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  const brand = await BrandProfile.findOne({ tenantId }).lean();
  return brand;
}

async function upsertBrandProfile({ tenantId, payload, updatedBy }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!payload || typeof payload !== "object") {
    throw ApiError.badRequest("payload is required");
  }
  // Whitelist top-level fields to prevent injection of arbitrary keys.
  const allowed = [
    "businessName",
    "description",
    "industry",
    "products",
    "services",
    "offers",
    "locations",
    "slogans",
    "audience",
    "brandVoice",
    "campaignGoals",
    "approvedClaims",
    "forbiddenClaims",
    "compliance",
    "defaultChannels",
    "defaultLanguage",
  ];
  const update = { tenantId, updatedBy: updatedBy || null };
  for (const key of allowed) {
    if (payload[key] !== undefined) update[key] = payload[key];
  }

  const before = await BrandProfile.findOne({ tenantId }).select({ _id: 1 }).lean();
  const brand = await BrandProfile.findOneAndUpdate(
    { tenantId },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();

  AuditLog.record({
    tenantId,
    userId: updatedBy,
    action: before ? "ai.brand_profile_updated" : "ai.brand_profile_created",
    entityType: "brand_profile",
    entityId: brand._id,
    description: before
      ? "Brand profile updated"
      : "Brand profile created",
    metadata: { businessName: brand.businessName || null },
  });
  return brand;
}

// ── Read-only listings ──────────────────────────────────────────────

async function listDrafts({ tenantId, status, channel, agent, page = 1, limit = 20 }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const filter = { tenantId };
  if (status) filter.status = status;
  if (channel) filter.channel = channel;
  if (agent) filter.agent = agent;

  const [docs, totalDocs] = await Promise.all([
    ContentDraft.find(filter)
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    ContentDraft.countDocuments(filter),
  ]);
  const totalPages = Math.ceil(totalDocs / lim) || 1;
  return { docs, page: pg, limit: lim, totalDocs, totalPages };
}

async function getDraft({ tenantId, draftId }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!draftId) throw ApiError.badRequest("draftId is required");
  return ContentDraft.findOne({ _id: draftId, tenantId }).lean();
}

export const AISocialContentService = {
  generateSocialContent,
  approveDraft,
  rejectDraft,
  getBrandProfile,
  upsertBrandProfile,
  listDrafts,
  getDraft,
};

// Named exports kept for direct usage from processors / tests.
export {
  generateSocialContent,
  approveDraft,
  rejectDraft,
  getBrandProfile,
  upsertBrandProfile,
  listDrafts,
  getDraft,
};
