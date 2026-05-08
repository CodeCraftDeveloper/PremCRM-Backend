/**
 * Prompt template seeds for the AI Social Content Generator and other
 * Phase 7 surfaces.
 *
 * This file is intentionally pure data + pure helpers — no DB writes, no
 * Mongoose imports. The AI orchestration layer (P7-002) and the tenant
 * onboarding flow consume `getPromptTemplateSeeds()` and persist the
 * results as `PromptTemplate` documents per tenant.
 *
 * Each seed is a `PromptTemplate.create()` payload minus `tenantId` and
 * `createdBy`. Versions start at 1; subsequent edits create new versions
 * with `previousVersionId` lineage following the same model pattern as
 * Workflow v2.
 *
 * Guardrail conventions:
 *   - `no_invented_business_facts` — output cannot claim anything not
 *     derivable from `brand_profile.approvedClaims` / description /
 *     products / services / slogans.
 *   - `no_legal_medical_financial_claims` — block regulated phrasing
 *     unless `brand_profile.compliance.<flag>` is true and the required
 *     disclosure is appended.
 *   - `no_forbidden_claims` — block any string in
 *     `brand_profile.forbiddenClaims` (case-insensitive).
 *   - `no_unverified_offers` — block discount/offer text unless an active
 *     `brand_profile.offers[]` entry covers it.
 *   - `no_external_trend_facts` — trends may inform tone/topic but cannot
 *     be presented as facts about the tenant's business.
 */

const STANDARD_SOCIAL_GUARDRAILS = [
  { id: "no_invented_business_facts", severity: "hard" },
  { id: "no_legal_medical_financial_claims", severity: "hard" },
  { id: "no_forbidden_claims", severity: "hard" },
  { id: "no_unverified_offers", severity: "hard" },
  { id: "no_external_trend_facts", severity: "hard" },
];

const STANDARD_REPLY_GUARDRAILS = [
  { id: "no_invented_business_facts", severity: "hard" },
  { id: "no_legal_medical_financial_claims", severity: "hard" },
  { id: "no_forbidden_claims", severity: "hard" },
];

const SOCIAL_CONTEXT_SOURCES = [
  "brand_profile",
  "campaign_goals",
  "trend_inputs",
  "audience",
  "offers",
];

/**
 * Default seed list. Order is stable so onboarding produces deterministic
 * lineage ids per tenant.
 */
export const PROMPT_TEMPLATE_SEEDS = Object.freeze([
  {
    name: "social.caption.generic",
    description:
      "Generic social caption generator across configured channels using brand profile, audience, and approved trends.",
    category: "social_caption",
    agent: "social.caption_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile"],
    contextSources: SOCIAL_CONTEXT_SOURCES,
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "caption"],
  },
  {
    name: "social.hashtag.set",
    description:
      "Channel-aware hashtag set generator. Returns ranked hashtags grouped by reach/relevance.",
    category: "social_hashtag_set",
    agent: "social.hashtag_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    requiredContext: ["brand_profile"],
    contextSources: SOCIAL_CONTEXT_SOURCES,
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "hashtags"],
  },
  {
    name: "social.calendar.idea",
    description:
      "Trend-aware content calendar idea generator that proposes posts per week/channel with rationale and confidence.",
    category: "social_calendar_idea",
    agent: "social.calendar_planner",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile", "campaign_goals"],
    contextSources: SOCIAL_CONTEXT_SOURCES,
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "calendar"],
  },
  {
    name: "social.product_launch.post",
    description:
      "Product launch post generator. Pulls product details from brand profile and never invents specs/SKUs not present.",
    category: "social_product_launch",
    agent: "social.product_launch_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile", "products"],
    contextSources: [...SOCIAL_CONTEXT_SOURCES, "products"],
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "product", "launch"],
  },
  {
    name: "social.offer.post",
    description:
      "Promotional offer post generator. Only emits discounts that map to an active brand_profile.offers[] entry.",
    category: "social_offer",
    agent: "social.offer_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile", "offers"],
    contextSources: [...SOCIAL_CONTEXT_SOURCES, "offers"],
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "offer", "discount"],
  },
  {
    name: "social.local_business.post",
    description:
      "Localized business post generator. Pulls location/region/language from brand profile.locations[].",
    category: "social_local_business",
    agent: "social.local_business_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile", "locations"],
    contextSources: [...SOCIAL_CONTEXT_SOURCES, "locations"],
    guardrails: STANDARD_SOCIAL_GUARDRAILS,
    requiresApproval: true,
    planFeature: "aiSocialContent",
    tags: ["social", "local"],
  },
  {
    name: "gmb.review.reply",
    description:
      "Google Business Profile review reply drafter using brand profile and the source review only.",
    category: "review_reply",
    agent: "gmb.review_reply_generator",
    status: "active",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-6",
    requiredContext: ["brand_profile", "gmb_review"],
    contextSources: ["brand_profile", "gmb_review"],
    guardrails: STANDARD_REPLY_GUARDRAILS,
    requiresApproval: true,
    planFeature: "reviewManagement",
    tags: ["gmb", "reviews", "reply"],
  },
]);

export function getPromptTemplateSeeds() {
  return PROMPT_TEMPLATE_SEEDS.map((seed) => ({
    ...seed,
    requiredContext: [...seed.requiredContext],
    contextSources: [...seed.contextSources],
    guardrails: seed.guardrails.map((g) => ({ ...g })),
    tags: [...seed.tags],
    version: 1,
  }));
}

export const STANDARD_GUARDRAILS = Object.freeze({
  social: STANDARD_SOCIAL_GUARDRAILS,
  reply: STANDARD_REPLY_GUARDRAILS,
});
