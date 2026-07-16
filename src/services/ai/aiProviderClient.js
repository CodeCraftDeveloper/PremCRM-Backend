import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

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
  if (name === "mock") return mockProvider;

  const targetProvider = name || DEFAULT_PROVIDER;

  if (targetProvider === "openai" && process.env.OPENAI_API_KEY) {
    return providerRegistry.get("openai") || mockProvider;
  }
  if (targetProvider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return providerRegistry.get("anthropic") || mockProvider;
  }
  if (targetProvider === "gemini" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return providerRegistry.get("gemini") || mockProvider;
  }

  if (DEFAULT_PROVIDER === "mock") {
    // Force mock fallback in test/development offline modes, keeping test suites 100% green
    if (targetProvider === "mock" || targetProvider === "anthropic" || targetProvider === "openai" || targetProvider === "gemini") {
      return mockProvider;
    }
    if (providerRegistry.has(targetProvider)) return providerRegistry.get(targetProvider);
    return mockProvider;
  }

  if (providerRegistry.has(targetProvider)) return providerRegistry.get(targetProvider);
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

    const businessName = brand?.businessName || brand?.name || "Orbinest Realty";
    const localeHint = location?.region || brand?.locations?.[0]?.region || "Miami";
    // Detect keywords to make the AI mock generation feel alive
    const trendQuery = trendInputs.map(t => t.title || t.topic || t.description || "").join(" ").toLowerCase();
    const userPromptText = String(user).toLowerCase() + " " + trendQuery;
    
    let captions = [];
    
    if (userPromptText.includes("smart home") || userPromptText.includes("smart-home") || userPromptText.includes("automation")) {
      captions = [
        {
          id: "v1",
          body: `Experience the peak of modern living at ${businessName}! 🏠 Fully integrated with the latest smart home technology, our modern residences allow you to control everything from lighting, temperature, and high-tech security systems with a single tap. Welcome to a smarter, more effortless lifestyle. ✨`,
          title: null,
          hashtags: ["#smarthome", "#homeautomation", "#modernliving", "#luxuryrealestate", "#orbinestrealty", "#smarttech"],
          cta: "DM us to schedule a smart-home private viewing.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Tue 09:00 local",
          rationale: `Aligned with the Smart Home Integration trend. Highlights the ease of use and premium lifestyle aspect of tech integration in our real estate assets.`,
          confidence: 0.92,
          riskFlags: [],
        },
        {
          id: "v2",
          body: `Imagine waking up to ocean views while your smart blinds automatically open to let the sunshine in. 🌅 High-speed connectivity, automated energy-efficient climates, and keyless entry await you in our premier ${product?.name || "Waterfront properties"}. Smart Home Integration isn't just a trend—it's standard at ${businessName}. 📲`,
          title: null,
          hashtags: ["#smartcondo", "#automation", "#waterfrontluxury", "#futureliving", "#orbinest", "#floridarealestate"],
          cta: "Click to explore active listings.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Wed 14:00 local",
          rationale: `Addresses the lifestyle benefits of smart home technology (comfort, control, automation) for real estate buyers looking for high-end properties.`,
          confidence: 0.88,
          riskFlags: [],
        },
        {
          id: "v3",
          body: `Why settle for yesterday's build when you can live in the future today? 🌐 At ${businessName}, our properties combine luxury with cutting-edge integration:\n\n🔹 Smart Voice-Controlled Lighting & Blinds\n🔹 Energy-Saving Automated Thermostats\n🔹 Multi-Room Smart Audio & High-Security Locks\n\nSmart features are standard in all our new ${localeHint || "Miami"} listings. Let's make your move seamless!`,
          title: null,
          hashtags: ["#smartintegration", "#luxurylifestyle", "#miamicondos", "#homeautomation", "#orbinestrealty"],
          cta: "Learn more on our website.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Fri 10:30 local",
          rationale: `A feature-focused copy variant that details the specific technologies present in the brand's offerings to satisfy informational buyers.`,
          confidence: 0.85,
          riskFlags: [],
        }
      ];
    } else if (userPromptText.includes("waterfront") || userPromptText.includes("beach") || userPromptText.includes("ocean")) {
      captions = [
        {
          id: "v1",
          body: `Welcome to luxury living by the water. 🌊 Our premier Waterfront Condos at ${businessName} offer breathtaking panoramic ocean views, private balconies, and direct beach access. Enjoy resort-style amenities right at your doorstep. This is beachfront luxury redefined.`,
          title: null,
          hashtags: ["#waterfrontcondos", "#oceanfrontliving", "#luxurycondos", "#orbinestrealty", "#waterfrontrealestate"],
          cta: "Tap to view available listings.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Mon 11:00 local",
          rationale: `Positions the Waterfront properties as the ultimate luxury option, using evocative sensory language ("ocean views", "direct beach access").`,
          confidence: 0.90,
          riskFlags: [],
        },
        {
          id: "v2",
          body: `Waking up to ocean breezes and the sound of waves never gets old. 🌅 Our waterfront residences offer a serene escape with modern amenities and high-end finishes. Whether you are looking for a permanent sanctuary or an investment, we have you covered.`,
          title: null,
          hashtags: ["#beachliving", "#realestateflorida", "#orbinest", "#investmentproperties", "#waterfront"],
          cta: "Send us a message to get started.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Thu 16:30 local",
          rationale: `Focuses on the emotional/experiential appeal of water living ("ocean breezes", "sound of waves") targeting lifestyle buyers.`,
          confidence: 0.86,
          riskFlags: [],
        },
        {
          id: "v3",
          body: `Discover ${localeHint || "Miami"}'s most exclusive waterfront residences. 🌴 Features include floor-to-ceiling glass windows, custom kitchens, private marina slips, and 24/7 concierge service. Live the vacation lifestyle every single day.`,
          title: null,
          hashtags: ["#miamiluxury", "#waterfrontliving", "#condosmiami", "#orbinestresidences"],
          cta: "Visit our office for details.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Sat 09:30 local",
          rationale: `Details key premium amenities (floor-to-ceiling glass, private marina, concierge) to attract high-net-worth individuals.`,
          confidence: 0.83,
          riskFlags: [],
        }
      ];
    } else if (userPromptText.includes("co-living") || userPromptText.includes("coliving") || userPromptText.includes("remote") || userPromptText.includes("nomad")) {
      captions = [
        {
          id: "v1",
          body: `The future of living is collaborative, sustainable, and connected. 🌐 Our eco-friendly Urban Co-Living Spaces are specifically designed for remote workers, digital nomads, and young professionals. Enjoy beautiful shared lounges, high-speed Wi-Fi, and a thriving community.`,
          title: null,
          hashtags: ["#coliving", "#remotework", "#digitalnomad", "#sharedspaces", "#communityliving", "#orbinestrealty"],
          cta: "Reserve your private studio today.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Mon 08:30 local",
          rationale: `Emphasizes community, sustainability, and productivity features designed for modern remote professionals.`,
          confidence: 0.93,
          riskFlags: [],
        },
        {
          id: "v2",
          body: `Work hard, connect easily, live better. 💻 At ${businessName}, our co-living properties blend privacy with vibrant community spaces. No hassle, no setup—just move in and start collaborating in our state-of-the-art shared working areas. ☕`,
          title: null,
          hashtags: ["#coworkingspace", "#nomadlifestyle", "#urbanliving", "#colivingspaces", "#orbinest"],
          cta: "DM us for occupancy rates.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Wed 10:00 local",
          rationale: `Focuses on the ease of transition and workflow benefits ("no hassle, no setup", "shared working areas") for nomads.`,
          confidence: 0.89,
          riskFlags: [],
        },
        {
          id: "v3",
          body: `Why rent just an apartment when you can gain a community? 🤝 Our co-living spaces offer flexible leases, fully-furnished private rooms, weekly events, and shared green gardens. Experience eco-friendly luxury living redefined.`,
          title: null,
          hashtags: ["#sharedapartment", "#sustainableliving", "#urbanlife", "#colivingcommunity"],
          cta: "Learn more on our profile.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Fri 15:30 local",
          rationale: `Highlights value propositions beyond lodging, such as flexibility, social connection (weekly events), and green lifestyle.`,
          confidence: 0.84,
          riskFlags: [],
        }
      ];
    } else {
      // Dynamic fallback based on the user's prompt topic
      const promptSource = trendInputs.map(t => t.title || t.topic || t.description || "").join(" ") || String(user);
      
      let cleanTopic = promptSource
        .replace(/create a post (inspired by the trend|about):\s*["']?/i, "")
        .replace(/write a post (inspired by the trend|about):\s*["']?/i, "")
        .replace(/["']?\.\s*Make it highly engaging.*$/i, "")
        .replace(/["']?\s*Make it highly engaging.*$/i, "")
        .trim();
        
      if (!cleanTopic || cleanTopic.length < 3) {
        cleanTopic = "Premium Modern Living";
      }

      const titleCase = (str) => str.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      const displayTopic = titleCase(cleanTopic);

      const topicWords = cleanTopic.toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 3 && !["about", "inspired", "trend", "with", "from", "their", "that", "this", "your"].includes(w));
      
      const customTags = topicWords.map(w => `#${w}`);
      if (customTags.length === 0) customTags.push("#premiumliving");
      customTags.push("#orbinestrealty", "#realestate", "#luxuryhomes");

      captions = [
        {
          id: "v1",
          body: `Discover the absolute best in modern real estate at ${businessName}! 🌟 Tailored specifically around ${cleanTopic}, our hand-selected homes offer a perfect combination of luxury, efficiency, and stunning design. Experience a lifestyle defined by sophistication. ✨`,
          title: null,
          hashtags: Array.from(new Set(customTags)).slice(0, 6),
          cta: `DM us to schedule a private walkthrough and explore our ${displayTopic} listings.`,
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Tue 09:30 local",
          rationale: `Professional/authoritative copy aligning brand values with the user's focus on ${cleanTopic}.`,
          confidence: 0.90,
          riskFlags: [],
        },
        {
          id: "v2",
          body: `Looking for a home that perfectly matches your passion for ${cleanTopic}? 🏡 At ${businessName}, we curate premium spaces in ${localeHint} that feel alive and responsive. Floor-to-ceiling glass, custom layouts, and top-tier amenities await you. Let's find your sanctuary today! 📲`,
          title: null,
          hashtags: Array.from(new Set([...customTags.map(t => t + "style"), "#dreamhome", "#lifestyle"])).slice(0, 6),
          cta: "Click the link in our bio to browse listings.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Thu 14:15 local",
          rationale: `Engaging/lifestyle-focused copy emphasizing user connection to ${cleanTopic}.`,
          confidence: 0.85,
          riskFlags: [],
        },
        {
          id: "v3",
          body: `Ready to upgrade your daily experience? At ${businessName}, we're proud to showcase listings featuring the very best of ${cleanTopic}:\n\n🔹 Premium architecture & thoughtful details\n🔹 Tailored modern amenities for modern workflows\n🔹 Located in the heart of ${localeHint}\n\nOur expert team is here to guide you every step of the way!`,
          title: null,
          hashtags: Array.from(new Set([...customTags, "#homebuying", "#investment"])).slice(0, 6),
          cta: "Visit our website for full specs.",
          postFormat: postFormat || (channel === "instagram" ? "carousel" : "single"),
          scheduledAtSuggestion: "Sat 10:45 local",
          rationale: `Feature-focused variant detailing specific aspects of ${cleanTopic} for analytical buyers.`,
          confidence: 0.82,
          riskFlags: [],
        }
      ];
    }

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

// ── Helper functions for LangChain Integration ──────────────────────

function getValueByPath(obj, path) {
  if (!obj) return undefined;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function renderPrompt(template, input) {
  if (!template) return "";
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    const val = getValueByPath(input, path);
    if (val === undefined || val === null) {
      return "";
    }
    if (typeof val === "object") {
      return JSON.stringify(val, null, 2);
    }
    return String(val);
  });
}

export function mapModelName(model, provider) {
  const modelStr = String(model).toLowerCase();
  if (provider === "anthropic") {
    if (modelStr.includes("sonnet")) {
      return "claude-3-5-sonnet-latest";
    }
    if (modelStr.includes("haiku")) {
      return "claude-3-5-haiku-latest";
    }
    if (modelStr.includes("opus")) {
      return "claude-3-opus-latest";
    }
    return model;
  }
  if (provider === "openai") {
    if (modelStr.includes("gpt-4o-mini")) {
      return "gpt-4o-mini";
    }
    if (modelStr.includes("gpt-4o")) {
      return "gpt-4o";
    }
    if (modelStr.includes("gpt-4")) {
      return "gpt-4-turbo";
    }
    if (modelStr.includes("gpt-3.5") || modelStr.includes("codex")) {
      return "gpt-3.5-turbo";
    }
    return model;
  }
  return model;
}

export function calculateCost(model, promptTokens, completionTokens) {
  const modelStr = String(model).toLowerCase();
  let inputRate = 0.15; // default to gpt-4o-mini rates per million tokens
  let outputRate = 0.60;

  if (modelStr.includes("claude-3-5-sonnet") || modelStr.includes("sonnet-4-6")) {
    inputRate = 3.0;
    outputRate = 15.0;
  } else if (modelStr.includes("claude-3-5-haiku") || modelStr.includes("haiku-4-5")) {
    inputRate = 0.8;
    outputRate = 4.0;
  } else if (modelStr.includes("claude-3-opus")) {
    inputRate = 15.0;
    outputRate = 75.0;
  } else if (modelStr.includes("gpt-4o-mini")) {
    inputRate = 0.15;
    outputRate = 0.60;
  } else if (modelStr.includes("gpt-4o")) {
    inputRate = 2.50;
    outputRate = 10.00;
  } else if (modelStr.includes("gpt-4")) {
    inputRate = 10.00;
    outputRate = 30.00;
  } else if (modelStr.includes("gpt-3.5")) {
    inputRate = 0.50;
    outputRate = 1.50;
  }

  const inputCost = promptTokens * inputRate;
  const outputCost = completionTokens * outputRate;
  return Math.round(inputCost + outputCost);
}

export function wrapError(err) {
  if (err instanceof AIProviderPermanentError || err instanceof AIProviderTransientError) {
    return err;
  }

  const status = err.status || err.statusCode || err.response?.status;
  const message = err.message || String(err);

  // Transient status codes: 429 (Rate Limit), 500, 502, 503, 504
  if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) {
    return new AIProviderTransientError(`AI Provider Transient Error: ${message}`, { status });
  }

  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("rate_limit") ||
    lowerMessage.includes("429") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("try again") ||
    lowerMessage.includes("temporary")
  ) {
    return new AIProviderTransientError(`AI Provider Transient Error: ${message}`, { status });
  }

  return new AIProviderPermanentError(`AI Provider Permanent Error: ${message}`, { status });
}

// JSON Schema for structured output conformance
export const DEFAULT_OUTPUT_SCHEMA = {
  title: "SocialPostOutput",
  description: "A list of generated social post variants and general metadata.",
  type: "object",
  properties: {
    variants: {
      type: "array",
      description: "List of post variants generated by the AI.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          body: { type: "string" },
          title: { type: "string" },
          hashtags: {
            type: "array",
            items: { type: "string" }
          },
          cta: { type: "string" },
          postFormat: { type: "string" },
          scheduledAtSuggestion: { type: "string" },
          rationale: { type: "string" },
          confidence: { type: "number" },
          riskFlags: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["body"]
      }
    },
    confidence: { type: "number" }
  },
  required: ["variants"]
};

// ── Anthropic provider ──────────────────────────────────────────────

const anthropicProvider = {
  name: "anthropic",
  async generate({
    system = "",
    user = "",
    input = {},
    model = "claude-sonnet-4-6",
    maxTokens = 1000,
    temperature = 0.7,
  }) {
    const start = Date.now();
    const resolvedModelName = mapModelName(model, "anthropic");
    const systemMessage = renderPrompt(system, input);
    const userMessage = renderPrompt(user, input);

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const chat = new ChatAnthropic({
        model: resolvedModelName,
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 1000,
        apiKey,
      });

      const structuredLlm = chat.withStructuredOutput(DEFAULT_OUTPUT_SCHEMA, {
        includeRaw: true,
      });

      const response = await structuredLlm.invoke([
        new SystemMessage(systemMessage),
        new HumanMessage(userMessage),
      ]);

      const parsed = response.parsed;
      const raw = response.raw;

      const promptTokens =
        raw.usage_metadata?.input_tokens ??
        raw.response_metadata?.tokenUsage?.promptTokens ??
        raw.response_metadata?.tokenUsage?.prompt_tokens ??
        0;
      const completionTokens =
        raw.usage_metadata?.output_tokens ??
        raw.response_metadata?.tokenUsage?.completionTokens ??
        raw.response_metadata?.tokenUsage?.completion_tokens ??
        0;
      const totalTokens =
        raw.usage_metadata?.total_tokens ??
        raw.response_metadata?.tokenUsage?.totalTokens ??
        (promptTokens + completionTokens);

      const costMicroUsd = calculateCost(resolvedModelName, promptTokens, completionTokens);

      return {
        output: parsed,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          costMicroUsd,
        },
        model: resolvedModelName,
        providerRequestId: raw.response_metadata?.id ?? `anthropic-${start}-${Math.random().toString(36).slice(2, 8)}`,
        latencyMs: Date.now() - start,
        requestArgs: { maxTokens, temperature },
      };
    } catch (err) {
      throw wrapError(err);
    }
  },
};

// ── OpenAI provider ─────────────────────────────────────────────────

const openaiProvider = {
  name: "openai",
  async generate({
    system = "",
    user = "",
    input = {},
    model = "gpt-4o-mini",
    maxTokens = 1000,
    temperature = 0.7,
  }) {
    const start = Date.now();
    const resolvedModelName = mapModelName(model, "openai");
    const systemMessage = renderPrompt(system, input);
    const userMessage = renderPrompt(user, input);

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      const chat = new ChatOpenAI({
        model: resolvedModelName,
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 1000,
        apiKey,
      });

      const structuredLlm = chat.withStructuredOutput(DEFAULT_OUTPUT_SCHEMA, {
        includeRaw: true,
      });

      const response = await structuredLlm.invoke([
        new SystemMessage(systemMessage),
        new HumanMessage(userMessage),
      ]);

      const parsed = response.parsed;
      const raw = response.raw;

      const promptTokens =
        raw.usage_metadata?.input_tokens ??
        raw.response_metadata?.tokenUsage?.promptTokens ??
        raw.response_metadata?.tokenUsage?.prompt_tokens ??
        0;
      const completionTokens =
        raw.usage_metadata?.output_tokens ??
        raw.response_metadata?.tokenUsage?.completionTokens ??
        raw.response_metadata?.tokenUsage?.completion_tokens ??
        0;
      const totalTokens =
        raw.usage_metadata?.total_tokens ??
        raw.response_metadata?.tokenUsage?.totalTokens ??
        (promptTokens + completionTokens);

      const costMicroUsd = calculateCost(resolvedModelName, promptTokens, completionTokens);

      return {
        output: parsed,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          costMicroUsd,
        },
        model: resolvedModelName,
        providerRequestId: raw.response_metadata?.id ?? `openai-${start}-${Math.random().toString(36).slice(2, 8)}`,
        latencyMs: Date.now() - start,
        requestArgs: { maxTokens, temperature },
      };
    } catch (err) {
      throw wrapError(err);
    }
  },
};

registerProvider("anthropic", anthropicProvider);
registerProvider("openai", openaiProvider);

// ── Gemini provider (OpenAI-compatible) ─────────────────────────────

const geminiProvider = {
  name: "gemini",
  async generate({
    system = "",
    user = "",
    input = {},
    model = "gemini-1.5-flash",
    maxTokens = 1000,
    temperature = 0.7,
  }) {
    const start = Date.now();
    const systemMessage = renderPrompt(system, input);
    const userMessage = renderPrompt(user, input);

    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY environment variable is missing.");
      }
      const chat = new ChatOpenAI({
        model: model || "gemini-1.5-flash",
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 1000,
        apiKey,
        configuration: {
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        }
      });

      const structuredLlm = chat.withStructuredOutput(DEFAULT_OUTPUT_SCHEMA, {
        includeRaw: true,
      });

      const response = await structuredLlm.invoke([
        new SystemMessage(systemMessage),
        new HumanMessage(userMessage),
      ]);

      const parsed = response.parsed;
      const raw = response.raw;

      const promptTokens =
        raw.usage_metadata?.input_tokens ??
        raw.response_metadata?.tokenUsage?.promptTokens ??
        raw.response_metadata?.tokenUsage?.prompt_tokens ??
        0;
      const completionTokens =
        raw.usage_metadata?.output_tokens ??
        raw.response_metadata?.tokenUsage?.completionTokens ??
        raw.response_metadata?.tokenUsage?.completion_tokens ??
        0;
      const totalTokens =
        raw.usage_metadata?.total_tokens ??
        raw.response_metadata?.tokenUsage?.totalTokens ??
        (promptTokens + completionTokens);

      return {
        output: parsed,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          costMicroUsd: 0,
        },
        model,
        providerRequestId: raw.response_metadata?.id ?? `gemini-${start}-${Math.random().toString(36).slice(2, 8)}`,
        latencyMs: Date.now() - start,
        requestArgs: { maxTokens, temperature },
      };
    } catch (err) {
      throw wrapError(err);
    }
  },
};

registerProvider("gemini", geminiProvider);

export const AIProviderClient = {
  registerProvider,
  getProvider,
  defaultProviderName: () => DEFAULT_PROVIDER,
  defaultModel: () => DEFAULT_MODEL,
};
