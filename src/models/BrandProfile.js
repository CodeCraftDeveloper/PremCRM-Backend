import mongoose from "mongoose";

/**
 * BrandProfile — single-source-of-truth tenant business profile fed into
 * every AI content surface. Holds everything the AI is allowed to claim
 * about the tenant: business description, products/services, slogans,
 * brand voice, audience, campaign goals, locations, plus explicit
 * approved/forbidden claim lists used by the guardrail layer.
 *
 * The AI Contract requires:
 *   - AI must NOT invent business facts.
 *   - AI must NOT make legal/medical/financial claims.
 *   - AI must NOT post anything not present in tenant-approved context.
 *
 * Those rules are enforced by:
 *   1. The context builder, which only loads BrandProfile fields when
 *      the prompt template requires them.
 *   2. The guardrail runtime, which rejects outputs that contain text
 *      not derivable from `approvedClaims` / `description` / products /
 *      services / slogans, or that contain any string in `forbiddenClaims`.
 *
 * One profile per tenant. Compound unique on tenantId enforced below.
 */

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: null },
    /** Optional pricing/SKU/url — never required, never auto-claimed by AI. */
    price: { type: String, trim: true, maxlength: 64, default: null },
    sku: { type: String, trim: true, maxlength: 128, default: null },
    url: { type: String, trim: true, maxlength: 1024, default: null },
    tags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
    },
  },
  { _id: false },
);

const serviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: null },
    tags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
    },
  },
  { _id: false },
);

const offerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: null },
    discount: { type: String, trim: true, maxlength: 64, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    /** Optional id used to retire stale offers from generated content. */
    externalId: { type: String, trim: true, maxlength: 128, default: null },
  },
  { _id: false },
);

const locationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 1000, default: null },
    region: { type: String, trim: true, maxlength: 128, default: null },
    country: { type: String, trim: true, maxlength: 64, default: null },
    language: { type: String, trim: true, maxlength: 16, default: null },
    timezone: { type: String, trim: true, maxlength: 64, default: null },
  },
  { _id: false },
);

const audienceSchema = new mongoose.Schema(
  {
    demographics: { type: String, trim: true, maxlength: 2000, default: null },
    psychographics: { type: String, trim: true, maxlength: 2000, default: null },
    painPoints: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      default: [],
    },
    goals: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      default: [],
    },
  },
  { _id: false },
);

const brandVoiceSchema = new mongoose.Schema(
  {
    tone: { type: String, trim: true, maxlength: 256, default: null },
    personality: { type: String, trim: true, maxlength: 1000, default: null },
    /** Words/phrases the brand intentionally uses. */
    vocabulary: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },
    /** Words/phrases the brand never uses. */
    doNotUse: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },
    /** Optional sample copy. */
    examples: {
      type: [{ type: String, trim: true, maxlength: 2000 }],
      default: [],
    },
  },
  { _id: false },
);

const campaignGoalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: null },
    kpi: { type: String, trim: true, maxlength: 200, default: null },
    targetWindow: { type: String, trim: true, maxlength: 128, default: null },
  },
  { _id: false },
);

const complianceSchema = new mongoose.Schema(
  {
    medical: { type: Boolean, default: false },
    financial: { type: Boolean, default: false },
    legal: { type: Boolean, default: false },
    /** Free-form notes for compliance reviewers. */
    notes: { type: String, trim: true, maxlength: 4000, default: null },
    /** Required disclosures the AI must append to certain outputs. */
    requiredDisclosures: {
      type: [{ type: String, trim: true, maxlength: 1000 }],
      default: [],
    },
  },
  { _id: false },
);

const brandProfileSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      unique: true,
      index: true,
    },

    businessName: { type: String, trim: true, maxlength: 256, default: null },
    description: { type: String, trim: true, maxlength: 4000, default: null },
    industry: { type: String, trim: true, maxlength: 128, default: null },

    products: { type: [productSchema], default: [] },
    services: { type: [serviceSchema], default: [] },
    offers: { type: [offerSchema], default: [] },
    locations: { type: [locationSchema], default: [] },

    slogans: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      default: [],
    },

    audience: { type: audienceSchema, default: () => ({}) },
    brandVoice: { type: brandVoiceSchema, default: () => ({}) },
    campaignGoals: { type: [campaignGoalSchema], default: [] },

    /**
     * Facts the AI is allowed to use as truthful claims about the tenant.
     * Anything not derivable from approvedClaims/description/products/
     * services/slogans is treated as invented and rejected by guardrails.
     */
    approvedClaims: {
      type: [{ type: String, trim: true, maxlength: 1000 }],
      default: [],
    },

    /**
     * Strings the AI must never emit (e.g. competitor names, retired
     * promises, regulated phrases). Guardrail enforcement is case-insensitive.
     */
    forbiddenClaims: {
      type: [{ type: String, trim: true, maxlength: 1000 }],
      default: [],
    },

    compliance: { type: complianceSchema, default: () => ({}) },

    /** Default channels the tenant publishes to. Drives copy length / tone. */
    defaultChannels: {
      type: [
        {
          type: String,
          enum: [
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
          ],
        },
      ],
      default: [],
    },

    /** Default content language; a single ISO-639-1 code. */
    defaultLanguage: {
      type: String,
      trim: true,
      maxlength: 16,
      default: "en",
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

const BrandProfile = mongoose.model("BrandProfile", brandProfileSchema);

export default BrandProfile;
