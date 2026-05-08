/**
 * AI Social Content Controller (P7-002).
 *
 * Thin handlers — all domain logic lives in
 * `services/ai/aiSocialContentService.js`. This controller only:
 *   - Validates basic request shape.
 *   - Forwards `tenantId` from `req.user` (never the body).
 *   - Maps `AISocialPermanentError` to a 400 so the client sees a
 *     readable reason instead of a 500.
 */

import {
  ApiError,
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";
import {
  AISocialContentService,
  AISocialPermanentError,
} from "../../services/ai/aiSocialContentService.js";
import { enqueue, QUEUE_NAMES } from "../../queue/index.js";

const SOCIAL_GENERATE_JOB = "social.content.generate";

export const getBrandProfile = asyncHandler(async (req, res, next) => {
  try {
    const profile = await AISocialContentService.getBrandProfile(
      req.user.tenantId,
    );
    successResponse(res, { profile }, "Brand profile retrieved");
  } catch (err) {
    next(err);
  }
});

export const upsertBrandProfile = asyncHandler(async (req, res, next) => {
  try {
    const profile = await AISocialContentService.upsertBrandProfile({
      tenantId: req.user.tenantId,
      payload: req.body || {},
      updatedBy: req.user._id,
    });
    successResponse(res, { profile }, "Brand profile saved", 200);
  } catch (err) {
    next(err);
  }
});

export const generateSocialDraft = asyncHandler(async (req, res, next) => {
  try {
    const body = req.body || {};
    const useQueue = req.query.async === "true" || body.async === true;

    if (useQueue) {
      const job = await enqueue(
        QUEUE_NAMES.AI_DRAFT,
        SOCIAL_GENERATE_JOB,
        {
          tenantId: String(req.user.tenantId),
          channel: body.channel,
          postFormat: body.postFormat || null,
          campaignGoal: body.campaignGoal || null,
          audienceHint: body.audienceHint || null,
          productName: body.productName || null,
          locationName: body.locationName || null,
          trendInputs: Array.isArray(body.trendInputs) ? body.trendInputs : [],
          agent: body.agent || undefined,
          triggeredBy: String(req.user._id),
          providerName: body.providerName || null,
          modelOverride: body.modelOverride || null,
          approvalRequest: body.approvalRequest !== false,
          relatedEntityType: body.relatedEntityType || null,
          relatedEntityId: body.relatedEntityId || null,
        },
        {
          idempotencyKey: body.idempotencyKey || undefined,
        },
      );
      return successResponse(
        res,
        { queued: true, jobId: job?.id || null },
        "Social content generation enqueued",
        202,
      );
    }

    const result = await AISocialContentService.generateSocialContent({
      tenantId: req.user.tenantId,
      channel: body.channel,
      postFormat: body.postFormat || null,
      campaignGoal: body.campaignGoal || null,
      audienceHint: body.audienceHint || null,
      productName: body.productName || null,
      locationName: body.locationName || null,
      trendInputs: Array.isArray(body.trendInputs) ? body.trendInputs : [],
      agent: body.agent || undefined,
      triggeredBy: req.user._id,
      providerName: body.providerName || null,
      modelOverride: body.modelOverride || null,
      approvalRequest: body.approvalRequest !== false,
      relatedEntityType: body.relatedEntityType || null,
      relatedEntityId: body.relatedEntityId || null,
      idempotencyKey: body.idempotencyKey || null,
    });
    return successResponse(
      res,
      result,
      "Social content draft generated",
      201,
    );
  } catch (err) {
    if (err instanceof AISocialPermanentError) {
      return next(ApiError.badRequest(err.message));
    }
    next(err);
  }
});

export const listSocialDrafts = asyncHandler(async (req, res, next) => {
  try {
    const { status, channel, agent, page, limit } = req.query;
    const result = await AISocialContentService.listDrafts({
      tenantId: req.user.tenantId,
      status,
      channel,
      agent,
      page,
      limit,
    });
    paginatedResponse(
      res,
      result.docs,
      {
        page: result.page,
        limit: result.limit,
        totalDocs: result.totalDocs,
        totalPages: result.totalPages,
      },
      "Social drafts retrieved",
    );
  } catch (err) {
    next(err);
  }
});

export const getSocialDraft = asyncHandler(async (req, res, next) => {
  try {
    const draft = await AISocialContentService.getDraft({
      tenantId: req.user.tenantId,
      draftId: req.params.id,
    });
    if (!draft) return next(ApiError.notFound("Content draft not found"));
    successResponse(res, { draft }, "Social draft retrieved");
  } catch (err) {
    next(err);
  }
});

export const approveSocialDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    const result = await AISocialContentService.approveDraft({
      tenantId: req.user.tenantId,
      draftId: req.params.id,
      decidedBy: req.user._id,
      decisionReason: decisionReason || null,
    });
    successResponse(
      res,
      result,
      result.alreadyApproved
        ? "Already approved"
        : "Social draft approved",
    );
  } catch (err) {
    next(err);
  }
});

export const rejectSocialDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    if (!decisionReason || String(decisionReason).trim().length < 1) {
      return next(
        ApiError.badRequest("decisionReason is required when rejecting"),
      );
    }
    const result = await AISocialContentService.rejectDraft({
      tenantId: req.user.tenantId,
      draftId: req.params.id,
      decidedBy: req.user._id,
      decisionReason: String(decisionReason).slice(0, 1000),
    });
    successResponse(
      res,
      result,
      result.alreadyRejected
        ? "Already rejected"
        : "Social draft rejected",
    );
  } catch (err) {
    next(err);
  }
});
