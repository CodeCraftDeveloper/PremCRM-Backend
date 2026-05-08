/**
 * AI Provider Client — pluggable abstraction over the underlying LLM
 * provider used by Phase 7 surfaces.
 *
 * Default provider is `mock`, a deterministic offline generator. The mock
 * is the production path until a real provider is wired (P7-003+) so
 * tests, CI, and offline development never depend on outbound calls.
 *
 * Real providers live behind the same interface:
 *
 *   provider.generate({ system, user, schemaName, model, maxTokens, temperature })
 *     → { output, usage: { promptTokens, completionTokens, totalTokens, costMicroUsd },
 *         model, providerRequestId, latencyMs }
 *
 * Output is the parsed structured object the orchestrator validates against
 * the prompt template's output schema. Providers MUST never throw provider
 * SDK errors directly — wrap them in `AIProviderPermanentError` (4xx /
 * malformed JSON) or `AIProviderTransientError` (5xx / rate limit) so the
 * orchestration layer can map them onto BullMQ retry behaviour.
 */

export class AIProviderPermanentError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "AIProviderPermanentError";
    this.permanent = true;
    this.code = code;
    this.status = status;
  }
}

export class AIProviderTransientError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "AIProviderTransientError";
    this.permanent = false;
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_PROVIDER = process.env.AI_PROVIDER || "mock";
const DEFAULT_MODEL = process.env.AI_DEFAULT_MODEL || "mock-social-1";

/**
 * Pluggable provider registry. Tests can override an individual provider
 * via `registerProvider("mock", customImpl)`.
 */
const providerRegistry = new Map();

export function registerProvider(name, impl) {
  if (!name || typeof name !== "string") {
    throw new Error("registerProvider: name is required");
  }
  if (!impl || typeof impl.generate !== "function") {
    throw new Error("registerProvider: impl.generate must be a function");
  }
  providerRegistry.set(name, impl);
}

export function getProvider(name = DEFAULT_PROVIDER) {
  if (providerRegistry.has(name)) return providerRegistry.get(name);
  if (name === "mock") return mockProvider;
  // Unknown provider → fall back to mock so dev environments don't hang
  // on a misconfigured AI_PROVIDER. Real providers must be registered
  // explicitly at boot.
  return mockProvider;
}

// ── Mock provider ───────────────────────────────────────────────────
//
// Builds a deterministic structured output by:
//   1. Pulling tenant-approved facts out of the resolved input (brand
//      profile + campaign goal + offer/product/location) — never
//      fabricates business names, products, prices, or claims.
//   2. Producing 1-3 caption variants, hashtag list, CTA, post format,
//      schedule suggestion, rationale, and self-reported confidence.
//   3. Reporting token counts derived from prompt + output character
//      length so usage metering is exercised in tests.

function clamp(text, max) {
  if (!text) return "";
  const s = String(text).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pickN(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, Math.max(0, n));
}

function buildCaptionFromContext({ brand, campaignGoal, channel, postFormat: _postFormat, audienceHint, offer, product, location }) {
  const businessName = brand?.businessName || brand?.name || "our team";
  const slogan = brand?.slogans?.[0] || null;
  const productName = product?.name || brand?.products?.[0]?.name || null;
  const serviceName = brand?.services?.[0]?.name || null;
  const goalSummary = campaignGoal?.name || campaignGoal || null;
  const channelHint = channel || brand?.defaultChannels?.[0] || "social";
  const localeHint = location?.region || brand?.locations?.[0]?.region || null;

  const lines = [];
  if (productName) {
    lines.push(`${businessName} — ${clamp(productName, 80)}.`);
  } else if (serviceName) {
    lines.push(`${businessName} — ${clamp(serviceName, 80)}.`);
  } else {
    lines.push(`${businessName}: ${clamp(brand?.description || "", 120)}`.trim());
  }
  if (offer?.name && offer?.discount) {
    lines.push(`Active offer: ${clamp(offer.name, 80)} (${clamp(offer.discount, 32)}).`);
  }
  if (goalSummary) lines.push(`Focus: ${clamp(goalSummary, 80)}.`);
  if (audienceHint) lines.push(`For: ${clamp(audienceHint, 80)}.`);
  if (slogan) lines.push(`— ${clamp(slogan, 120)}`);
  if (localeHint) lines.push(`Serving ${clamp(localeHint, 80)}.`);
  const limit =
    channelHint === "x" ? 240 : channelHint === "instagram" ? 1500 : 1800;
  return clamp(lines.filter(Boolean).join(" "), limit);
}

function buildHashtags({ brand, channel }) {
  const seeds = [];
  if (brand?.industry) seeds.push(brand.industry);
  if (brand?.products?.[0]?.name) seeds.push(brand.products[0].name);
  if (brand?.services?.[0]?.name) seeds.push(brand.services[0].name);
  if (Array.isArray(brand?.brandVoice?.vocabulary)) {
    seeds.push(...brand.brandVoice.vocabulary.slice(0, 3));
  }
  const channelTag = channel ? channel.replace(/[^a-z0-9]/gi, "") : null;
  const tags = seeds
    .map((s) => String(s).replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => `#${t.toLowerCase()}`);
  if (channelTag) tags.push(`#${channelTag.toLowerCase()}`);
  return Array.from(new Set(tags)).slice(0, 8);
}

function buildCta({ campaignGoal, offer, channel }) {
  if (offer?.name) return `Tap to view this week's offer.`;
  const goalName = campaignGoal?.name || campaignGoal;
  if (goalName && /lead|signup|register/i.test(String(goalName))) {
    return `Send us a message to get started.`;
  }
  if (channel === "gmb") return `Visit us this week.`;
  return `Learn more on our profile.`;
}

function tokensFromText(text) {
  // Rough deterministic token estimate: 4 chars per token.
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

const mockProvider = {
  name: "mock",
  async generate({ system = "", user = "", input = {}, model = DEFAULT_MODEL, maxTokens = null, temperature = null }) {
    const start = Date.now();
    const brand = input?.brand_profile || {};
    const campaignGoal = input?.campaign_goal || null;
    const channel = input?.channel || null;
    const postFormat = input?.post_format || null;
    const audienceHint = input?.audience_hint || null;
    const offer = input?.offer || null;
    const product = input?.product || null;
    const location = input?.location || null;
    const trendInputs = Array.isArray(input?.trend_inputs)
      ? input.trend_inputs
      : [];

    const variantSeeds = [
      { tone: "primary" },
      { tone: "playful" },
      { tone: "informational" },
    ];

    const captions = variantSeeds.map((seed, idx) => {
      const base = buildCaptionFromContext({
        brand,
        campaignGoal,
        channel,
        postFormat,
        audienceHint,
        offer,
        product,
        location,
      });
      const trendNote =
        trendInputs[0] && idx === 1
          ? ` Inspired by trending topic: ${clamp(trendInputs[0].title || trendInputs[0].topic || "", 80)}.`
          : "";
      const toneSuffix =
        seed.tone === "playful"
          ? " 👏"
          : seed.tone === "informational"
            ? ""
            : "";
      return {
        id: `v${idx + 1}`,
        body: `${base}${trendNote}${toneSuffix}`.trim(),
        title: null,
        hashtags: buildHashtags({ brand, channel }),
        cta: buildCta({ campaignGoal, offer, channel }),
        postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
        scheduledAtSuggestion: "Tue 09:00 local",
        rationale:
          `Built from brand profile (${pickN(brand?.products || [], 3).map((p) => p.name).join(", ") || "no products"}). ` +
          `Trend inputs used: ${trendInputs.length}.`,
        confidence: idx === 0 ? 0.78 : idx === 1 ? 0.7 : 0.65,
        riskFlags: [],
      };
    });

    const promptTokens = tokensFromText(`${system}\n${user}`);
    const completionTokens = captions.reduce(
      (sum, v) => sum + tokensFromText(`${v.body} ${v.cta} ${v.hashtags.join(" ")}`),
      0,
    );

    const output = {
      action: "draft_social_post",
      variants: captions,
      confidence: Math.max(...captions.map((c) => c.confidence ?? 0)),
      reasons: [
        "Generated from tenant brand profile only.",
        trendInputs.length
          ? `Trend inputs incorporated: ${trendInputs.length}`
          : "No trend inputs supplied.",
      ],
      requiredApproval: true,
      escalationReason: null,
      toolCalls: [],
    };

    return {
      output,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        // Mock cost ~ $0 to avoid affecting any analytics aggregation.
        costMicroUsd: 0,
      },
      model,
      providerRequestId: `mock-${start}-${Math.random().toString(36).slice(2, 8)}`,
      latencyMs: Date.now() - start,
      requestArgs: { maxTokens, temperature },
    };
  },
};

registerProvider("mock", mockProvider);

export const AIProviderClient = {
  registerProvider,
  getProvider,
  defaultProviderName: () => DEFAULT_PROVIDER,
  defaultModel: () => DEFAULT_MODEL,
};
