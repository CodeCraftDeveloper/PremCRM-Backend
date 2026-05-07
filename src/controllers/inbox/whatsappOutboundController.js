import {
  ApiError,
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";
import ApprovalRequest from "../../models/ApprovalRequest.js";
import { enqueue } from "../../queue/index.js";
import { WhatsappOutboundService } from "../../services/whatsappOutboundService.js";

export const createWhatsappDraft = asyncHandler(async (req, res, next) => {
  try {
    const {
      body,
      to,
      autoApprove,
      aiGenerated,
      aiRunId,
      confidence,
      channelAccountId,
    } = req.body || {};

    const { message, approvalRequest } =
      await WhatsappOutboundService.composeDraft({
        tenantId: req.user.tenantId,
        conversationId: req.params.conversationId,
        channelAccountId,
        body,
        to,
        aiGenerated: Boolean(aiGenerated),
        aiRunId: aiRunId || null,
        confidence: typeof confidence === "number" ? confidence : null,
        sentByUserId: req.user._id,
      });

    if (autoApprove === true && !aiGenerated) {
      const result = await WhatsappOutboundService.approveDraft({
        tenantId: req.user.tenantId,
        approvalRequestId: approvalRequest._id,
        decidedBy: req.user._id,
        decisionReason: "Auto-approved by author",
        autoApprove: true,
        enqueueFn: enqueue,
      });
      return successResponse(
        res,
        { message, approvalRequest: result.approval, queued: true },
        "WhatsApp draft auto-approved and queued",
        201,
      );
    }

    successResponse(
      res,
      { message, approvalRequest, queued: false },
      "WhatsApp draft created and pending approval",
      201,
    );
  } catch (error) {
    next(error);
  }
});

export const listWhatsappApprovals = asyncHandler(async (req, res, next) => {
  try {
    const { status, page, limit } = req.query;
    const pg = Math.max(parseInt(page) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const filter = {
      tenantId: req.user.tenantId,
      type: "whatsapp.send",
    };
    if (status) filter.status = status;

    const [approvals, totalDocs] = await Promise.all([
      ApprovalRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((pg - 1) * lim)
        .limit(lim)
        .lean(),
      ApprovalRequest.countDocuments(filter),
    ]);

    paginatedResponse(
      res,
      approvals,
      {
        page: pg,
        limit: lim,
        totalDocs,
        totalPages: Math.ceil(totalDocs / lim) || 1,
      },
      "WhatsApp approvals retrieved",
    );
  } catch (error) {
    next(error);
  }
});

export const approveWhatsappDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    const result = await WhatsappOutboundService.approveDraft({
      tenantId: req.user.tenantId,
      approvalRequestId: req.params.id,
      decidedBy: req.user._id,
      decisionReason: decisionReason || null,
      enqueueFn: enqueue,
    });
    successResponse(
      res,
      result,
      result.alreadyApproved ? "Already approved" : "Approved and queued",
    );
  } catch (error) {
    next(error);
  }
});

export const rejectWhatsappDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    if (!decisionReason || String(decisionReason).trim().length < 1) {
      return next(
        ApiError.badRequest("decisionReason is required when rejecting"),
      );
    }
    const result = await WhatsappOutboundService.rejectDraft({
      tenantId: req.user.tenantId,
      approvalRequestId: req.params.id,
      decidedBy: req.user._id,
      decisionReason: String(decisionReason).slice(0, 1000),
    });
    successResponse(
      res,
      result,
      result.alreadyRejected ? "Already rejected" : "Rejected",
    );
  } catch (error) {
    next(error);
  }
});
