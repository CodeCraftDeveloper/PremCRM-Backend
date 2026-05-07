import {
  ApiError,
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";
import ApprovalRequest from "../../models/ApprovalRequest.js";
import { GmailOutboundService } from "../../services/gmailOutboundService.js";
import { enqueue } from "../../queue/index.js";

/**
 * @route   POST /api/v1/inbox/gmail/conversations/:conversationId/draft
 * @desc    Create an outbound Gmail draft for the conversation.
 *          Body: { body, htmlBody?, subject?, to?, cc?, bcc?, autoApprove?,
 *                  aiGenerated?, aiRunId?, confidence? }
 *          When `autoApprove` is true and the draft is not AI-generated, the
 *          send is queued immediately (still audited).
 */
export const createGmailDraft = asyncHandler(async (req, res, next) => {
  try {
    const {
      body,
      htmlBody,
      subject,
      to,
      cc,
      bcc,
      autoApprove,
      aiGenerated,
      aiRunId,
      confidence,
      channelAccountId,
    } = req.body || {};

    const { message, approvalRequest } =
      await GmailOutboundService.composeDraft({
        tenantId: req.user.tenantId,
        conversationId: req.params.conversationId,
        channelAccountId,
        body,
        htmlBody,
        subject,
        to,
        cc,
        bcc,
        aiGenerated: Boolean(aiGenerated),
        aiRunId: aiRunId || null,
        confidence:
          typeof confidence === "number" ? confidence : null,
        sentByUserId: req.user._id,
      });

    if (autoApprove === true && !aiGenerated) {
      const result = await GmailOutboundService.approveDraft({
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
        "Gmail draft auto-approved and queued",
        201,
      );
    }

    successResponse(
      res,
      { message, approvalRequest, queued: false },
      "Gmail draft created and pending approval",
      201,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/inbox/gmail/approvals
 * @desc    List Gmail approval requests for the tenant.
 *          Query: { status?, page?, limit? }
 */
export const listGmailApprovals = asyncHandler(async (req, res, next) => {
  try {
    const { status, page, limit } = req.query;
    const pg = Math.max(parseInt(page) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const filter = {
      tenantId: req.user.tenantId,
      type: "gmail.send",
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
      "Gmail approvals retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/inbox/gmail/approvals/:id/approve
 * @desc    Approve a pending Gmail draft and queue the send.
 *          Body: { decisionReason? }
 */
export const approveGmailDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    const result = await GmailOutboundService.approveDraft({
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

/**
 * @route   POST /api/v1/inbox/gmail/approvals/:id/reject
 * @desc    Reject a pending Gmail draft. Marks the related Message as failed.
 *          Body: { decisionReason? }
 */
export const rejectGmailDraft = asyncHandler(async (req, res, next) => {
  try {
    const { decisionReason } = req.body || {};
    if (!decisionReason || String(decisionReason).trim().length < 1) {
      return next(
        ApiError.badRequest("decisionReason is required when rejecting"),
      );
    }
    const result = await GmailOutboundService.rejectDraft({
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
