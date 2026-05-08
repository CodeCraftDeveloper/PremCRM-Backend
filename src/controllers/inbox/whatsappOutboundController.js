import {
  ApiError,
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";
import ApprovalRequest from "../../models/ApprovalRequest.js";
import { enqueue } from "../../queue/index.js";
import { WhatsappOutboundService } from "../../services/whatsappOutboundService.js";
import {
  WhatsappMediaUploadPermanentError,
  WhatsappOutboundMediaService,
} from "../../services/whatsappOutboundMediaService.js";

export const getWhatsappWindowStatus = asyncHandler(async (req, res, next) => {
  try {
    const status = await WhatsappOutboundService.getCustomerServiceWindow({
      tenantId: req.user.tenantId,
      conversationId: req.params.conversationId,
    });
    successResponse(res, status, "WhatsApp customer-service window status");
  } catch (err) {
    next(err);
  }
});

export const createWhatsappTemplateDraft = asyncHandler(
  async (req, res, next) => {
    try {
      const {
        templateName,
        language,
        components,
        to,
        autoApprove,
        aiGenerated,
        aiRunId,
        confidence,
        channelAccountId,
      } = req.body || {};

      const { message, approvalRequest, template } =
        await WhatsappOutboundService.composeTemplateDraft({
          tenantId: req.user.tenantId,
          conversationId: req.params.conversationId,
          channelAccountId,
          templateName,
          language,
          components,
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
          {
            message,
            approvalRequest: result.approval,
            template,
            queued: true,
          },
          "WhatsApp template draft auto-approved and queued",
          201,
        );
      }

      successResponse(
        res,
        { message, approvalRequest, template, queued: false },
        "WhatsApp template draft created and pending approval",
        201,
      );
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Compose a WhatsApp outbound media draft. Accepts either:
 *
 *  1. `multipart/form-data` with a `file` field (multer memory storage)
 *     plus form fields `mediaType`, `caption`, etc. — admin uploads a
 *     fresh attachment.
 *  2. JSON body with `storageKey` (and optional `mimeType`/`filename`)
 *     — re-attach an already-stored asset (typically a previously
 *     downloaded inbound media from P6-004a).
 *
 * The controller orchestrates: upload-or-S3-source → Cloud API
 * `/media` upload → `composeMediaDraft` → optional auto-approve.
 */
export const createWhatsappMediaDraft = asyncHandler(
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const file = req.file;
      const {
        mediaType,
        caption,
        storageKey,
        filename: filenameField,
        mimeType: mimeTypeField,
        to,
        autoApprove,
        aiGenerated,
        aiRunId,
        confidence,
        channelAccountId,
      } = body;

      if (!mediaType) {
        return next(ApiError.badRequest("mediaType is required"));
      }

      let source;
      let resolvedFilename = filenameField || null;
      let resolvedMime = mimeTypeField || null;
      if (file) {
        source = {
          kind: "buffer",
          buffer: file.buffer,
          mimeType: file.mimetype,
          filename: file.originalname || filenameField || "upload.bin",
        };
        resolvedFilename = source.filename;
        resolvedMime = source.mimeType;
      } else if (storageKey) {
        source = {
          kind: "s3",
          storageKey,
          mimeType: mimeTypeField || null,
          filename: filenameField || null,
        };
      } else {
        return next(
          ApiError.badRequest(
            "Either a multipart `file` upload or a `storageKey` is required",
          ),
        );
      }

      const upload = await WhatsappOutboundMediaService.uploadOutboundMedia({
        tenantId: req.user.tenantId,
        channelAccountId,
        mediaType,
        source,
        filename: resolvedFilename,
        mimeType: resolvedMime,
        caption: caption || null,
      });

      const { message, approvalRequest } =
        await WhatsappOutboundService.composeMediaDraft({
          tenantId: req.user.tenantId,
          conversationId: req.params.conversationId,
          channelAccountId,
          mediaType: upload.mediaType,
          providerMediaId: upload.providerMediaId,
          mimeType: upload.mimeType,
          filename: upload.filename,
          sizeBytes: upload.sizeBytes,
          storageKey: upload.storageKey,
          caption: caption || "",
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
          {
            message,
            approvalRequest: result.approval,
            providerMediaId: upload.providerMediaId,
            queued: true,
          },
          "WhatsApp media draft auto-approved and queued",
          201,
        );
      }

      return successResponse(
        res,
        {
          message,
          approvalRequest,
          providerMediaId: upload.providerMediaId,
          queued: false,
        },
        "WhatsApp media draft created and pending approval",
        201,
      );
    } catch (err) {
      // Permanent upload errors are user-facing 400-class failures; map
      // them to ApiError.badRequest so the client gets a useful message
      // instead of a 500.
      if (err instanceof WhatsappMediaUploadPermanentError) {
        return next(
          ApiError.badRequest(
            err.message || "WhatsApp media upload rejected",
          ),
        );
      }
      next(err);
    }
  },
);

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
