import mongoose from "mongoose";

/**
 * ContentDraft — persisted AI-generated draft (social caption, hashtag
 * set, calendar idea, email/reply draft, review reply, etc.) that must
 * be reviewable, editable, cancellable, and auditable BEFORE any
 * external publish/send fires.
 *
 * Per the AI Contract:
 *   - Draft persistence is mandatory before publish.
 *   - Each draft links to the AIRun that produced it (`aiRunId`) and the
 *     prompt template version pinned at run-start.
 *   - Each draft carries confidence, risk flags, and `requiresApproval`
 *     (default TRUE).
 *   - Multi-variant generations live in `variants[]`. The selected variant
 *     becomes the canonical output the publish path reads.
 *
 * ContentDraft is referenced by ApprovalRequest (`relatedEntityType:
 * "content_draft"`) and by future SocialPost / Message records via
 * `contentDraftId`.
 */

export const CONTENT_DRAFT_STATUSES = Object.freeze([
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "cancelled",
  "published",
  "failed",
]);

export const CONTENT_DRAFT_CONTENT_TYPES = Object.freeze([
  "social_caption",
  "social_hashtag_set",
  "social_calendar_idea",
  "social_product_launch",
  "social_offer",
  "social_local_business",
  "email_draft",
  "email_reply",
  "whatsapp_reply",
  "review_reply",
  "blog_post",
  "ad_copy",
  "other",
]);

export const CONTENT_DRAFT_CHANNELS = Object.freeze([
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

const variantSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    /** Primary copy. Caption, body, headline, etc. */
    body: { type: String, maxlength: 32_000, default: "" },
    /** Optional secondary fields populated per content type. */
    title: { type: String, trim: true, maxlength: 500, default: null },
    hashtags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
    },
    cta: { type: String, trim: true, maxlength: 256, default: null },
    postFormat: { type: String, trim: true, maxlength: 64, default: null },
    mediaSuggestions: {
      type: [{ type: String, trim: true, maxlength: 512 }],
      default: [],
    },
    /** Recommended publish window (e.g. "Tue 09:00 local"). */
    scheduledAtSuggestion: { type: String, trim: true, maxlength: 128, default: null },
    rationale: { type: String, trim: true, maxlength: 4000, default: null },
    confidence: { type: Number, min: 0, max: 1, default: null },
    /** Per-variant risk flags surfaced by guardrails. */
    riskFlags: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },
  },
  { _id: false },
);

const contextSourceSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 64 },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    label: { type: String, trim: true, maxlength: 256, default: null },
    approved: { type: Boolean, default: true },
  },
  { _id: false },
);

const contentDraftSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AIRun",
      required: true,
      index: true,
    },

    promptTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PromptTemplate",
      default: null,
    },
    promptTemplateName: { type: String, trim: true, maxlength: 200, default: null },
    promptTemplateVersion: { type: Number, min: 1, default: null },

    contentType: {
      type: String,
      enum: CONTENT_DRAFT_CONTENT_TYPES,
      required: true,
    },

    channel: {
      type: String,
      enum: CONTENT_DRAFT_CHANNELS,
      default: null,
    },

    /** Stable agent identifier — denormalized from AIRun for fast filtering. */
    agent: { type: String, trim: true, maxlength: 128, default: null },

    /** Generated variants. At least one is required by the service layer. */
    variants: { type: [variantSchema], default: [] },

    /** Selected variant id — must match a `variants[].id`. */
    selectedVariantId: { type: String, trim: true, maxlength: 64, default: null },

    contextSources: { type: [contextSourceSchema], default: [] },

    /** Aggregate confidence across variants (max or weighted avg by service). */
    confidence: { type: Number, min: 0, max: 1, default: null },

    /** Aggregate risk flags. */
    riskFlags: {
      type: [{ type: String, trim: true, maxlength: 128 }],
      default: [],
    },

    requiresApproval: { type: Boolean, default: true },

    approvalRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovalRequest",
      default: null,
    },

    status: {
      type: String,
      enum: CONTENT_DRAFT_STATUSES,
      default: "draft",
      index: true,
    },

    /**
     * Optional polymorphic link to the entity this draft is FOR — e.g.
     * an inbox conversation (reply draft), a CRM lead (qualification),
     * or a GMB review (review reply). Phase 9 SocialPost will consume
     * approved drafts via SocialPost.contentDraftId rather than this link.
     */
    relatedEntityType: {
      type: String,
      enum: [
        "conversation",
        "message",
        "lead",
        "contact",
        "deal",
        "review",
        "campaign",
        null,
      ],
      default: null,
    },
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    /** Idempotency key — same (tenantId, idempotencyKey) collapses replays. */
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    /** Free-form metadata for surface-specific fields. */
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /** Lifecycle timestamps for analytics. */
    submittedForApprovalAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

contentDraftSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
contentDraftSchema.index({ tenantId: 1, contentType: 1, createdAt: -1 });
contentDraftSchema.index({ tenantId: 1, channel: 1, status: 1 });
contentDraftSchema.index({
  tenantId: 1,
  relatedEntityType: 1,
  relatedEntityId: 1,
});

contentDraftSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "content_draft_idempotency_uniq",
  },
);

contentDraftSchema.pre("validate", function preValidate() {
  // selectedVariantId must reference an actual variant when provided
  if (this.selectedVariantId) {
    const ids = (this.variants || []).map((v) => v.id);
    if (!ids.includes(this.selectedVariantId)) {
      this.invalidate(
        "selectedVariantId",
        `selectedVariantId "${this.selectedVariantId}" does not match any variants[].id`,
      );
    }
  }
  // variant ids must be unique within the draft
  if (Array.isArray(this.variants) && this.variants.length > 0) {
    const seen = new Set();
    for (const variant of this.variants) {
      if (!variant?.id) continue;
      if (seen.has(variant.id)) {
        this.invalidate(
          "variants",
          `variants[].id values must be unique within a draft (duplicate "${variant.id}")`,
        );
        break;
      }
      seen.add(variant.id);
    }
  }
});

const ContentDraft = mongoose.model("ContentDraft", contentDraftSchema);

export default ContentDraft;
