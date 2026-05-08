import crypto from "crypto";
import AIRun from "../models/AIRun.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import BrandProfile from "../models/BrandProfile.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import ContentDraft from "../models/ContentDraft.js";
import GmbLocation from "../models/GmbLocation.js";
import Review from "../models/Review.js";
import ReviewReplyDraft from "../models/ReviewReplyDraft.js";
import PromptTemplate from "../models/PromptTemplate.js";
import { enqueue, QUEUE_NAMES } from "../queue/index.js";
import { ApiError } from "../utils/apiResponse.js";
import { incrementUsage } from "./usageMeterService.js";
import { AIProviderClient } from "./ai/aiProviderClient.js";

export const REVIEW_PUBLISH_JOB = "review.reply.publish";
const AGENT = "gmb.review_reply_generator";

export class GmbReviewPermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "GmbReviewPermanentError";
    this.permanent = true;
  }
}

const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
const star = (value) =>
  ["ONE", "TWO", "THREE", "FOUR", "FIVE"].includes(value)
    ? value
    : ["ONE", "TWO", "THREE", "FOUR", "FIVE"][
        Math.min(Math.max(Number(value) || 1, 1), 5) - 1
      ];
const rating = (value) => ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[value] || 1);

async function upsertLocation({ tenantId, payload }) {
  const account = await ChannelAccount.findOne({
    _id: payload?.channelAccountId,
    tenantId,
    provider: "gmb",
    deletedAt: null,
  }).lean();
  if (!account) throw ApiError.notFound("GMB channel account not found");
  if (!payload?.providerLocationId) throw ApiError.badRequest("providerLocationId is required");
  if (!payload?.title && !payload?.locationName) throw ApiError.badRequest("title is required");

  return GmbLocation.findOneAndUpdate(
    { tenantId, providerLocationId: String(payload.providerLocationId).trim() },
    {
      $set: {
        tenantId,
        channelAccountId: account._id,
        providerLocationId: String(payload.providerLocationId).trim(),
        providerAccountId: payload.providerAccountId || account.providerAccountId,
        title: String(payload.title || payload.locationName).trim(),
        status: payload.status || "active",
        verificationStatus: payload.verificationStatus || "unknown",
        address: payload.address || {},
        categories: Array.isArray(payload.categories) ? payload.categories : [],
        providerMeta: payload.providerMeta || {},
        deletedAt: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();
}

async function listLocations({ tenantId }) {
  const docs = await GmbLocation.find({ tenantId, deletedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  return { docs, page: 1, limit: docs.length || 20, totalDocs: docs.length, totalPages: 1 };
}

async function syncReviews({ tenantId, locationId, reviews = [], syncCursor = null }) {
  const location = await GmbLocation.findOne({ _id: locationId, tenantId, deletedAt: null });
  if (!location) throw ApiError.notFound("GMB location not found");
  if (!Array.isArray(reviews)) throw ApiError.badRequest("reviews must be an array");

  let inserted = 0;
  let updated = 0;
  for (const raw of reviews) {
    const providerReviewId = raw.providerReviewId || raw.reviewId || raw.name;
    if (!providerReviewId) throw ApiError.badRequest("Each review requires providerReviewId");
    const starRating = star(raw.starRating || raw.rating);
    const existed = await Review.exists({ tenantId, provider: "gmb", providerReviewId });
    await Review.findOneAndUpdate(
      { tenantId, provider: "gmb", providerReviewId },
      {
        $set: {
          tenantId,
          channelAccountId: location.channelAccountId,
          gmbLocationId: location._id,
          provider: "gmb",
          providerReviewId,
          reviewer: { displayName: raw.reviewerName || raw.reviewer?.displayName || null },
          starRating,
          rating: rating(starRating),
          comment: raw.comment || raw.reviewText || "",
          status: raw.status || (raw.providerReply || raw.reply ? "replied" : "needs_reply"),
          providerCreateTime: raw.providerCreateTime || raw.createTime || null,
          providerUpdateTime: raw.providerUpdateTime || raw.updateTime || null,
          providerReply: {
            comment: raw.providerReply?.comment || raw.reply?.comment || null,
            updateTime: raw.providerReply?.updateTime || raw.reply?.updateTime || null,
          },
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    if (existed) updated += 1;
    else inserted += 1;
  }
  location.syncCursor = syncCursor || location.syncCursor || null;
  location.lastReviewSyncedAt = new Date();
  await location.save();
  return { upserted: inserted + updated, inserted, updated, location: location.toObject() };
}

async function listReviews({ tenantId }) {
  const docs = await Review.find({ tenantId }).sort({ providerCreateTime: -1, createdAt: -1 }).lean();
  return { docs, page: 1, limit: docs.length || 20, totalDocs: docs.length, totalPages: 1 };
}

async function generateReplyDraft({ tenantId, reviewId, triggeredBy = null, idempotencyKey = null }) {
  const review = await Review.findOne({ _id: reviewId, tenantId });
  if (!review) throw ApiError.notFound("GMB review not found");
  const brand = await BrandProfile.findOne({ tenantId }).lean();
  const template = await PromptTemplate.findOne({
    tenantId,
    agent: AGENT,
    status: "active",
    archivedAt: null,
  }).sort({ version: -1 }).lean();
  if (!brand) throw new GmbReviewPermanentError("Tenant brand profile is required before generating review replies.");
  if (!template) throw new GmbReviewPermanentError(`No active prompt template found for agent "${AGENT}".`);

  const key = idempotencyKey || hash(`${tenantId}:${reviewId}:${review.updatedAt}`);
  const existing = await ReviewReplyDraft.findOne({ tenantId, idempotencyKey: key }).lean();
  if (existing) {
    return {
      aiRun: await AIRun.findById(existing.aiRunId).lean(),
      replyDraft: existing,
      draft: await ContentDraft.findById(existing.contentDraftId).lean(),
      approvalRequest: await ApprovalRequest.findById(existing.approvalRequestId).lean(),
      review: await Review.findById(review._id).lean(),
      reused: true,
    };
  }

  const aiRun = await AIRun.create({
    tenantId,
    agent: AGENT,
    promptTemplateId: template._id,
    promptTemplateName: template.name,
    promptTemplateVersion: template.version,
    promptTemplateLineageId: template.lineageId || template._id,
    modelProvider: template.modelProvider || "anthropic",
    model: template.model || AIProviderClient.defaultModel(),
    status: "running",
    input: { reviewId: review._id, rating: review.rating },
    contextSources: [{ type: "brand_profile", refId: brand._id }, { type: "gmb_review", refId: review._id }],
    requiresApproval: true,
    idempotencyKey: key,
    triggeredBy,
    startedAt: new Date(),
  });
  const providerResult = await AIProviderClient.getProvider().generate({
    system: template.systemPrompt || "",
    user: template.userPromptTemplate || "",
    input: { brand_profile: brand, gmb_review: { rating: review.rating, comment: review.comment }, channel: "gmb" },
    model: template.model || AIProviderClient.defaultModel(),
  });
  const first = providerResult.output?.variants?.[0] || {};
  const body = String(first.body || `Thank you for your ${review.rating}-star review. We appreciate your feedback.`).trim();
  const confidence = providerResult.output?.confidence ?? first.confidence ?? null;
  const contentDraft = await ContentDraft.create({
    tenantId,
    aiRunId: aiRun._id,
    promptTemplateId: template._id,
    promptTemplateName: template.name,
    promptTemplateVersion: template.version,
    contentType: "review_reply",
    channel: "gmb",
    agent: AGENT,
    variants: [{ id: "v1", body, confidence }],
    selectedVariantId: "v1",
    confidence,
    requiresApproval: true,
    status: "pending_approval",
    relatedEntityType: "review",
    relatedEntityId: review._id,
    idempotencyKey: key,
    createdBy: triggeredBy,
    submittedForApprovalAt: new Date(),
  });
  const replyDraft = await ReviewReplyDraft.create({
    tenantId,
    channelAccountId: review.channelAccountId,
    gmbLocationId: review.gmbLocationId,
    reviewId: review._id,
    body,
    source: "ai",
    status: "pending_approval",
    aiRunId: aiRun._id,
    contentDraftId: contentDraft._id,
    confidence,
    idempotencyKey: key,
    createdBy: triggeredBy,
  });
  const approval = await ApprovalRequest.create({
    tenantId,
    type: "gmb.reply",
    status: "pending",
    relatedEntityType: "review_reply",
    relatedEntityId: replyDraft._id,
    summary: body.slice(0, 2000),
    aiGenerated: true,
    aiRunId: aiRun._id,
    confidence,
    requestedBy: triggeredBy,
  });
  Object.assign(replyDraft, { approvalRequestId: approval._id });
  Object.assign(contentDraft, { approvalRequestId: approval._id });
  Object.assign(review, { replyDraftId: replyDraft._id, approvalRequestId: approval._id, aiRunId: aiRun._id, status: "reply_pending_approval" });
  await Promise.all([
    replyDraft.save(),
    contentDraft.save(),
    review.save(),
    AIRun.updateOne({ _id: aiRun._id }, { $set: { status: "succeeded", finishedAt: new Date(), usage: providerResult.usage || {}, contentDraftId: contentDraft._id, approvalRequestId: approval._id, confidence } }),
  ]);
  await incrementUsage(tenantId, "aiRuns", 1);
  if (providerResult.usage?.totalTokens > 0) await incrementUsage(tenantId, "aiTokens", providerResult.usage.totalTokens);
  return { aiRun: await AIRun.findById(aiRun._id).lean(), draft: contentDraft.toObject(), replyDraft: replyDraft.toObject(), approvalRequest: approval.toObject(), review: review.toObject() };
}

async function listApprovals({ tenantId }) {
  const docs = await ApprovalRequest.find({ tenantId, type: "gmb.reply" }).lean();
  return { docs, page: 1, limit: docs.length || 20, totalDocs: docs.length, totalPages: 1 };
}

async function approveReply({ tenantId, approvalRequestId, decidedBy, enqueueFn = enqueue }) {
  const approval = await ApprovalRequest.findOne({ _id: approvalRequestId, tenantId, type: "gmb.reply" });
  if (!approval) throw ApiError.notFound("GMB reply approval request not found");
  const replyDraft = await ReviewReplyDraft.findOne({ _id: approval.relatedEntityId, tenantId });
  if (!replyDraft) throw ApiError.notFound("Review reply draft not found");
  Object.assign(approval, { status: "approved", decidedBy, decidedAt: new Date() });
  Object.assign(replyDraft, { status: "approved", decidedBy, decidedAt: new Date() });
  await Promise.all([approval.save(), replyDraft.save(), ContentDraft.updateOne({ _id: replyDraft.contentDraftId, tenantId }, { $set: { status: "approved", decidedAt: new Date() } })]);
  const job = await enqueueFn(QUEUE_NAMES.GMB_REVIEWS, REVIEW_PUBLISH_JOB, { tenantId: String(tenantId), replyDraftId: String(replyDraft._id), approvalRequestId: String(approval._id) }, { idempotencyKey: `gmb.reply:${replyDraft.idempotencyKey}` });
  return { approval: approval.toObject(), replyDraft: replyDraft.toObject(), alreadyApproved: false, jobId: job?.id || null };
}

async function rejectReply({ tenantId, approvalRequestId, decisionReason }) {
  if (!decisionReason) throw ApiError.badRequest("decisionReason is required when rejecting");
  const approval = await ApprovalRequest.findOne({ _id: approvalRequestId, tenantId, type: "gmb.reply" });
  if (!approval) throw ApiError.notFound("GMB reply approval request not found");
  const replyDraft = await ReviewReplyDraft.findOne({ _id: approval.relatedEntityId, tenantId });
  Object.assign(approval, { status: "rejected", decidedAt: new Date(), decisionReason });
  Object.assign(replyDraft, { status: "rejected", decidedAt: new Date() });
  await Promise.all([approval.save(), replyDraft.save(), ContentDraft.updateOne({ _id: replyDraft.contentDraftId, tenantId }, { $set: { status: "rejected" } })]);
  return { approval: approval.toObject(), replyDraft: replyDraft.toObject(), alreadyRejected: false };
}

async function publishApprovedReply({ tenantId, replyDraftId }) {
  const replyDraft = await ReviewReplyDraft.findOne({ _id: replyDraftId, tenantId });
  if (!replyDraft) throw new GmbReviewPermanentError("Review reply draft not found");
  if (replyDraft.status === "published") return { skipped: true, replyDraftId: String(replyDraft._id), publishedAt: replyDraft.publishedAt };
  if (!["approved", "publishing"].includes(replyDraft.status)) throw new GmbReviewPermanentError(`Cannot publish GMB reply in status "${replyDraft.status}"`);
  const publishedAt = new Date();
  Object.assign(replyDraft, { status: "published", publishedAt, providerUpdateTime: publishedAt, providerReplyId: `stub:gmb:${replyDraft.reviewId}:reply` });
  await replyDraft.save();
  await Review.updateOne({ _id: replyDraft.reviewId, tenantId }, { $set: { status: "replied", providerReply: { comment: replyDraft.body, updateTime: publishedAt } } });
  await ContentDraft.updateOne({ _id: replyDraft.contentDraftId, tenantId }, { $set: { status: "published", publishedAt } });
  await incrementUsage(tenantId, "reviewReplies", 1);
  return { skipped: false, replyDraftId: String(replyDraft._id), providerReplyId: replyDraft.providerReplyId, publishedAt };
}

export const GmbReviewReplyService = {
  REVIEW_PUBLISH_JOB,
  upsertLocation,
  listLocations,
  syncReviews,
  listReviews,
  generateReplyDraft,
  listApprovals,
  approveReply,
  rejectReply,
  publishApprovedReply,
};
