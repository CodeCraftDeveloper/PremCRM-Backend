import crypto from "crypto";
import ApprovalRequest from "../models/ApprovalRequest.js";
import AuditLog from "../models/AuditLog.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import ContactIdentity from "../models/inbox/ContactIdentity.js";
import Conversation from "../models/inbox/Conversation.js";
import Message from "../models/inbox/Message.js";
import { QUEUE_NAMES } from "../queue/index.js";
import { ApiError } from "../utils/apiResponse.js";
import { incrementUsage } from "./usageMeterService.js";
import { TokenVaultService } from "./tokenVaultService.js";
import { WhatsappTemplateService } from "./whatsappTemplateService.js";
import logger from "../utils/logger.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v20.0";
const WHATSAPP_SEND_JOB_NAME = "whatsapp.message.send";

/**
 * WhatsApp customer-service window: Meta allows freeform (non-template)
 * outbound messages within 24 hours of the customer's last inbound
 * message. Outside that window, only approved templates may be sent.
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

class WhatsappSendPermanentError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WhatsappSendPermanentError";
    this.permanent = true;
    this.status = status;
  }
}

class WhatsappSendTransientError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WhatsappSendTransientError";
    this.permanent = false;
    this.status = status;
  }
}

function genIdempotencyKey() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeWhatsappIdentifier(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d]/g, "");
  if (!digits || digits.length < 6 || digits.length > 20) {
    throw ApiError.badRequest("Invalid WhatsApp recipient phone number");
  }
  return `+${digits}`;
}

function toCloudRecipient(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

/**
 * Returns the most recent inbound WhatsApp message timestamp on a
 * conversation. Used to evaluate the 24-hour customer-service window.
 */
async function getLastInboundAt({ tenantId, conversationId }) {
  const last = await Message.findOne({
    tenantId,
    conversationId,
    channel: "whatsapp",
    direction: "inbound",
  })
    .sort({ createdAt: -1 })
    .select({ createdAt: 1, providerTimestamp: 1 })
    .lean();
  if (!last) return null;
  return last.providerTimestamp || last.createdAt || null;
}

/**
 * Computes the customer-service window status for a conversation.
 * Returns `{ open, lastInboundAt, expiresAt, msRemaining }`.
 *
 * `open === true` means freeform messages are allowed for the next
 * `msRemaining` ms. `open === false` means only approved templates
 * may be sent.
 */
async function getCustomerServiceWindow({ tenantId, conversationId, now = new Date() }) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!conversationId) throw ApiError.badRequest("conversationId is required");
  const lastInboundAt = await getLastInboundAt({ tenantId, conversationId });
  if (!lastInboundAt) {
    return { open: false, lastInboundAt: null, expiresAt: null, msRemaining: 0 };
  }
  const expiresAt = new Date(
    new Date(lastInboundAt).getTime() + CUSTOMER_SERVICE_WINDOW_MS,
  );
  const msRemaining = Math.max(0, expiresAt.getTime() - now.getTime());
  return {
    open: msRemaining > 0,
    lastInboundAt,
    expiresAt,
    msRemaining,
  };
}

async function resolveRecipient({ tenantId, conversation, explicitTo }) {
  if (explicitTo) return normalizeWhatsappIdentifier(explicitTo);

  if (conversation.contactIdentityId) {
    const identity = await ContactIdentity.findOne({
      _id: conversation.contactIdentityId,
      tenantId,
      provider: "whatsapp",
    }).lean();
    if (identity?.providerIdentifier) {
      return normalizeWhatsappIdentifier(identity.providerIdentifier);
    }
  }

  if (conversation.providerThreadId) {
    const [left] = String(conversation.providerThreadId).split(":");
    if (left) return normalizeWhatsappIdentifier(left);
  }

  throw ApiError.badRequest("Recipient (to) is required");
}

async function getWhatsappCredentials(tenantId, channelAccountId) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  }).select("+credentials");

  if (!account) {
    throw new WhatsappSendPermanentError(
      "WhatsApp channel account not found",
      0,
    );
  }
  if (account.status !== "connected") {
    throw new WhatsappSendPermanentError(
      `WhatsApp account is not connected (status=${account.status})`,
      0,
    );
  }
  if (!account.credentials) {
    throw new WhatsappSendPermanentError(
      "WhatsApp account credentials are missing",
      0,
    );
  }

  const credentials = TokenVaultService.decryptJson(
    "whatsapp",
    account.credentials,
    { tenantId },
  );
  if (!credentials.accessToken) {
    throw new WhatsappSendPermanentError(
      "WhatsApp access token is missing",
      0,
    );
  }

  const phoneNumberId =
    credentials.phoneNumberId ||
    account.providerMeta?.whatsapp?.phoneNumberId ||
    account.providerAccountId;

  return { account, credentials, phoneNumberId };
}

async function composeDraft({
  tenantId,
  conversationId,
  channelAccountId,
  body = "",
  to,
  aiGenerated = false,
  aiRunId = null,
  confidence = null,
  sentByUserId = null,
  metadata = {},
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!conversationId) throw ApiError.badRequest("conversationId is required");
  const normalizedBody = String(body || "").trim();
  if (!normalizedBody) throw ApiError.badRequest("body is required");

  const conversation = await Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (conversation.channel !== "whatsapp") {
    throw ApiError.badRequest(
      `Conversation channel ${conversation.channel} is not whatsapp`,
    );
  }

  const resolvedChannelAccountId =
    channelAccountId || conversation.channelAccountId;
  const account = await ChannelAccount.findOne({
    _id: resolvedChannelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("WhatsApp channel account not found");
  if (account.status !== "connected") {
    throw ApiError.badRequest(
      `WhatsApp account is not connected (status=${account.status})`,
    );
  }

  // Enforce the 24-hour customer-service window for freeform sends.
  // Freeform composeDraft is text-only — outside the window callers
  // must use composeTemplateDraft with an approved Meta template.
  const windowStatus = await getCustomerServiceWindow({
    tenantId,
    conversationId: conversation._id,
  });
  if (!windowStatus.open) {
    throw ApiError.badRequest(
      "WhatsApp 24-hour customer-service window is closed; use an approved template",
    );
  }

  const recipient = await resolveRecipient({
    tenantId,
    conversation,
    explicitTo: to,
  });
  const idempotencyKey = genIdempotencyKey();
  const providerThreadId =
    conversation.providerThreadId ||
    `${recipient}:${account.providerAccountId}`;

  const message = await Message.create({
    tenantId,
    conversationId: conversation._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    direction: "outbound",
    status: "pending",
    contentType: "text",
    body: normalizedBody,
    senderIdentifier: account.providerAccountId,
    senderName: account.displayName || account.providerAccountId,
    sentByUserId: sentByUserId || null,
    contactIdentityId: conversation.contactIdentityId || null,
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    providerMeta: {
      whatsapp: {
        idempotencyKey,
        recipient,
        providerThreadId,
        type: "text",
      },
    },
  });

  const approvalRequest = await ApprovalRequest.create({
    tenantId,
    type: "whatsapp.send",
    status: "pending",
    relatedEntityType: "message",
    relatedEntityId: message._id,
    summary: normalizedBody.slice(0, 200),
    metadata: {
      ...metadata,
      conversationId: String(conversation._id),
      channelAccountId: String(account._id),
      to: recipient,
    },
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    confidence,
    requestedBy: sentByUserId || null,
  });

  await Message.updateOne(
    { _id: message._id, tenantId },
    { $set: { approvalRequestId: approvalRequest._id } },
  );

  AuditLog.record({
    tenantId,
    userId: sentByUserId || null,
    action: "whatsapp.draft_created",
    entityType: "message",
    entityId: message._id,
    description: `WhatsApp draft created for conversation ${conversation._id}`,
    metadata: {
      approvalRequestId: String(approvalRequest._id),
      aiGenerated: Boolean(aiGenerated),
      to: recipient,
    },
  });

  return { message, approvalRequest };
}

/**
 * Compose a pending WhatsApp template message draft. Templates can be
 * sent regardless of the 24-hour customer-service window, so this path
 * does NOT call `getCustomerServiceWindow`. The supplied template name
 * + language must resolve to a tenant-scoped template with
 * `status === "approved"`. Body parameters are validated against the
 * stored template's `bodyParameterCount`.
 */
async function composeTemplateDraft({
  tenantId,
  conversationId,
  channelAccountId,
  templateName,
  language,
  components = [],
  to,
  aiGenerated = false,
  aiRunId = null,
  confidence = null,
  sentByUserId = null,
  metadata = {},
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!conversationId) throw ApiError.badRequest("conversationId is required");
  if (!templateName) throw ApiError.badRequest("templateName is required");
  if (!language) throw ApiError.badRequest("language is required");

  const conversation = await Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (conversation.channel !== "whatsapp") {
    throw ApiError.badRequest(
      `Conversation channel ${conversation.channel} is not whatsapp`,
    );
  }

  const resolvedChannelAccountId =
    channelAccountId || conversation.channelAccountId;
  const account = await ChannelAccount.findOne({
    _id: resolvedChannelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("WhatsApp channel account not found");
  if (account.status !== "connected") {
    throw ApiError.badRequest(
      `WhatsApp account is not connected (status=${account.status})`,
    );
  }

  const template = await WhatsappTemplateService.findApprovedTemplate({
    tenantId,
    name: templateName,
    language,
    channelAccountId: account._id,
  });

  // Validate provided parameters against the stored template
  // (throws ApiError.badRequest on mismatch).
  const sendComponents = WhatsappTemplateService.buildSendComponents({
    template,
    components,
  });
  const previewBody = WhatsappTemplateService.renderTemplatePreview({
    template,
    components,
  });

  const recipient = await resolveRecipient({
    tenantId,
    conversation,
    explicitTo: to,
  });
  const idempotencyKey = genIdempotencyKey();
  const providerThreadId =
    conversation.providerThreadId ||
    `${recipient}:${account.providerAccountId}`;

  const message = await Message.create({
    tenantId,
    conversationId: conversation._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    direction: "outbound",
    status: "pending",
    contentType: "template",
    body: previewBody,
    senderIdentifier: account.providerAccountId,
    senderName: account.displayName || account.providerAccountId,
    sentByUserId: sentByUserId || null,
    contactIdentityId: conversation.contactIdentityId || null,
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    providerMeta: {
      whatsapp: {
        idempotencyKey,
        recipient,
        providerThreadId,
        type: "template",
        template: {
          templateId: String(template._id),
          name: template.name,
          language: template.language,
          components: sendComponents,
        },
      },
    },
  });

  const approvalRequest = await ApprovalRequest.create({
    tenantId,
    type: "whatsapp.send",
    status: "pending",
    relatedEntityType: "message",
    relatedEntityId: message._id,
    summary: previewBody.slice(0, 200),
    metadata: {
      ...metadata,
      conversationId: String(conversation._id),
      channelAccountId: String(account._id),
      to: recipient,
      template: {
        templateId: String(template._id),
        name: template.name,
        language: template.language,
      },
    },
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    confidence,
    requestedBy: sentByUserId || null,
  });

  await Message.updateOne(
    { _id: message._id, tenantId },
    { $set: { approvalRequestId: approvalRequest._id } },
  );

  AuditLog.record({
    tenantId,
    userId: sentByUserId || null,
    action: "whatsapp.template_draft_created",
    entityType: "message",
    entityId: message._id,
    description: `WhatsApp template draft "${template.name}/${template.language}" created`,
    metadata: {
      approvalRequestId: String(approvalRequest._id),
      aiGenerated: Boolean(aiGenerated),
      to: recipient,
      templateId: String(template._id),
    },
  });

  return { message, approvalRequest, template };
}

/**
 * Compose a pending WhatsApp media (image/video/audio/document) draft.
 *
 * The caller must have already uploaded the binary to Cloud API via
 * `WhatsappOutboundMediaService.uploadOutboundMedia` and supply the
 * resulting `providerMediaId`. This service does NOT call Graph; it
 * only persists the pending Message + ApprovalRequest.
 *
 * Freeform media (this path) is gated by the same 24-hour
 * customer-service window as freeform text. Outside the window the
 * caller must use a media template (P6-004c).
 */
async function composeMediaDraft({
  tenantId,
  conversationId,
  channelAccountId,
  mediaType,
  providerMediaId,
  mimeType,
  filename = null,
  sizeBytes = null,
  storageKey = null,
  caption = "",
  to,
  aiGenerated = false,
  aiRunId = null,
  confidence = null,
  sentByUserId = null,
  metadata = {},
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!conversationId) throw ApiError.badRequest("conversationId is required");
  if (!mediaType) throw ApiError.badRequest("mediaType is required");
  if (!MEDIA_CONTENT_TYPES_OUTBOUND.has(mediaType)) {
    throw ApiError.badRequest(
      `mediaType must be one of image|video|audio|document (got "${mediaType}")`,
    );
  }
  if (!providerMediaId) {
    throw ApiError.badRequest("providerMediaId is required");
  }
  const normalizedCaption = String(caption || "").trim();

  const conversation = await Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (conversation.channel !== "whatsapp") {
    throw ApiError.badRequest(
      `Conversation channel ${conversation.channel} is not whatsapp`,
    );
  }

  const resolvedChannelAccountId =
    channelAccountId || conversation.channelAccountId;
  const account = await ChannelAccount.findOne({
    _id: resolvedChannelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("WhatsApp channel account not found");
  if (account.status !== "connected") {
    throw ApiError.badRequest(
      `WhatsApp account is not connected (status=${account.status})`,
    );
  }

  // Freeform media is bound by the 24-hour customer-service window per
  // Meta. Outside the window, callers must use a media template instead
  // (P6-004c).
  const windowStatus = await getCustomerServiceWindow({
    tenantId,
    conversationId: conversation._id,
  });
  if (!windowStatus.open) {
    throw ApiError.badRequest(
      "WhatsApp 24-hour customer-service window is closed; use an approved media template",
    );
  }

  const recipient = await resolveRecipient({
    tenantId,
    conversation,
    explicitTo: to,
  });
  const idempotencyKey = genIdempotencyKey();
  const providerThreadId =
    conversation.providerThreadId ||
    `${recipient}:${account.providerAccountId}`;

  const previewBody = normalizedCaption || `[${mediaType}]`;

  const message = await Message.create({
    tenantId,
    conversationId: conversation._id,
    channelAccountId: account._id,
    channel: "whatsapp",
    direction: "outbound",
    status: "pending",
    contentType: mediaType,
    body: previewBody,
    senderIdentifier: account.providerAccountId,
    senderName: account.displayName || account.providerAccountId,
    sentByUserId: sentByUserId || null,
    contactIdentityId: conversation.contactIdentityId || null,
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    attachments: [
      {
        filename: filename || null,
        mimeType: mimeType || null,
        sizeBytes:
          typeof sizeBytes === "number" && sizeBytes >= 0 ? sizeBytes : 0,
        storageKey: storageKey || null,
        providerMediaId: String(providerMediaId),
      },
    ],
    providerMeta: {
      whatsapp: {
        idempotencyKey,
        recipient,
        providerThreadId,
        type: mediaType,
        media: {
          providerMediaId: String(providerMediaId),
          mimeType: mimeType || null,
          filename: filename || null,
          sizeBytes:
            typeof sizeBytes === "number" && sizeBytes >= 0 ? sizeBytes : null,
          storageKey: storageKey || null,
          caption: normalizedCaption || null,
        },
      },
    },
  });

  const approvalRequest = await ApprovalRequest.create({
    tenantId,
    type: "whatsapp.send",
    status: "pending",
    relatedEntityType: "message",
    relatedEntityId: message._id,
    summary: previewBody.slice(0, 200),
    metadata: {
      ...metadata,
      conversationId: String(conversation._id),
      channelAccountId: String(account._id),
      to: recipient,
      media: {
        providerMediaId: String(providerMediaId),
        mediaType,
        mimeType: mimeType || null,
        filename: filename || null,
      },
    },
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    confidence,
    requestedBy: sentByUserId || null,
  });

  await Message.updateOne(
    { _id: message._id, tenantId },
    { $set: { approvalRequestId: approvalRequest._id } },
  );

  AuditLog.record({
    tenantId,
    userId: sentByUserId || null,
    action: "whatsapp.media_draft_created",
    entityType: "message",
    entityId: message._id,
    description: `WhatsApp ${mediaType} draft created for conversation ${conversation._id}`,
    metadata: {
      approvalRequestId: String(approvalRequest._id),
      aiGenerated: Boolean(aiGenerated),
      to: recipient,
      providerMediaId: String(providerMediaId),
      mediaType,
    },
  });

  return { message, approvalRequest };
}

async function approveDraft({
  tenantId,
  approvalRequestId,
  decidedBy,
  decisionReason = null,
  enqueueFn,
  autoApprove = false,
}) {
  if (!enqueueFn) {
    throw new Error("approveDraft requires an enqueueFn (DI for tests)");
  }

  const approval = await ApprovalRequest.findOne({
    _id: approvalRequestId,
    tenantId,
  });
  if (!approval) throw ApiError.notFound("Approval request not found");
  if (approval.type !== "whatsapp.send") {
    throw ApiError.badRequest(
      `Approval request type is ${approval.type}, not whatsapp.send`,
    );
  }
  if (approval.status === "approved" || approval.status === "auto_approved") {
    return { approval, alreadyApproved: true };
  }
  if (approval.status !== "pending") {
    throw ApiError.badRequest(
      `Approval request is ${approval.status}; cannot approve`,
    );
  }

  const message = await Message.findOne({
    _id: approval.relatedEntityId,
    tenantId,
    channel: "whatsapp",
    direction: "outbound",
  });
  if (!message) throw ApiError.notFound("Message not found");
  if (message.status !== "pending") {
    throw ApiError.badRequest(
      `Message status ${message.status} is not pending`,
    );
  }

  const idempotencyKey = message.providerMeta?.whatsapp?.idempotencyKey;
  if (!idempotencyKey) {
    throw ApiError.internal("Message is missing an idempotency key");
  }

  approval.status = autoApprove ? "auto_approved" : "approved";
  approval.decidedBy = decidedBy || null;
  approval.decidedAt = new Date();
  approval.decisionReason = decisionReason;
  await approval.save();

  await enqueueFn(
    QUEUE_NAMES.WHATSAPP_MESSAGES,
    WHATSAPP_SEND_JOB_NAME,
    {
      tenantId: String(tenantId),
      messageId: String(message._id),
      channelAccountId: String(message.channelAccountId),
    },
    { idempotencyKey: `whatsapp.send:${idempotencyKey}` },
  );

  AuditLog.record({
    tenantId,
    userId: decidedBy || null,
    action: autoApprove ? "whatsapp.auto_approved" : "whatsapp.approved",
    entityType: "approval_request",
    entityId: approval._id,
    description: `WhatsApp outbound message approved (message ${message._id})`,
    metadata: { messageId: String(message._id) },
  });

  return { approval, message };
}

async function rejectDraft({
  tenantId,
  approvalRequestId,
  decidedBy,
  decisionReason = null,
}) {
  const approval = await ApprovalRequest.findOne({
    _id: approvalRequestId,
    tenantId,
  });
  if (!approval) throw ApiError.notFound("Approval request not found");
  if (approval.type !== "whatsapp.send") {
    throw ApiError.badRequest(
      `Approval request type is ${approval.type}, not whatsapp.send`,
    );
  }
  if (approval.status === "rejected") {
    return { approval, alreadyRejected: true };
  }
  if (approval.status !== "pending") {
    throw ApiError.badRequest(
      `Approval request is ${approval.status}; cannot reject`,
    );
  }

  approval.status = "rejected";
  approval.decidedBy = decidedBy || null;
  approval.decidedAt = new Date();
  approval.decisionReason = decisionReason;
  await approval.save();

  const message = await Message.findOneAndUpdate(
    {
      _id: approval.relatedEntityId,
      tenantId,
      channel: "whatsapp",
      direction: "outbound",
      status: "pending",
    },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        failureReason: decisionReason || "Rejected by reviewer",
      },
    },
    { new: true },
  );

  AuditLog.record({
    tenantId,
    userId: decidedBy || null,
    action: "whatsapp.rejected",
    entityType: "approval_request",
    entityId: approval._id,
    description: "WhatsApp outbound message rejected",
    metadata: { messageId: message ? String(message._id) : null },
  });

  return { approval, message };
}

const MEDIA_CONTENT_TYPES_OUTBOUND = new Set([
  "image",
  "video",
  "audio",
  "document",
]);

function buildCloudPayload({ recipient, message }) {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toCloudRecipient(recipient),
  };
  const meta = message.providerMeta?.whatsapp || {};
  if (message.contentType === "template" || meta.type === "template") {
    const template = meta.template;
    if (!template?.name || !template?.language) {
      throw new WhatsappSendPermanentError(
        "Template metadata missing on message",
        0,
      );
    }
    return {
      ...base,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(Array.isArray(template.components) && template.components.length
          ? { components: template.components }
          : {}),
      },
    };
  }
  if (
    MEDIA_CONTENT_TYPES_OUTBOUND.has(message.contentType) ||
    MEDIA_CONTENT_TYPES_OUTBOUND.has(meta.type)
  ) {
    const mediaType = MEDIA_CONTENT_TYPES_OUTBOUND.has(message.contentType)
      ? message.contentType
      : meta.type;
    const media = meta.media;
    if (!media?.providerMediaId) {
      throw new WhatsappSendPermanentError(
        "Media providerMediaId missing on message",
        0,
      );
    }
    const mediaPayload = { id: media.providerMediaId };
    const caption = (message.body || "").trim();
    if (caption && (mediaType === "image" || mediaType === "video" || mediaType === "document")) {
      mediaPayload.caption = caption;
    }
    if (mediaType === "document" && media.filename) {
      mediaPayload.filename = media.filename;
    }
    return {
      ...base,
      type: mediaType,
      [mediaType]: mediaPayload,
    };
  }
  return {
    ...base,
    type: "text",
    text: {
      preview_url: false,
      body: message.body,
    },
  };
}

async function postWhatsappSend({ phoneNumberId, accessToken, payload }) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status;
    const errorMessage =
      data?.error?.message ||
      data?.error?.error_data?.details ||
      `WhatsApp send failed with HTTP ${status}`;
    if (status === 429 || status >= 500) {
      throw new WhatsappSendTransientError(errorMessage, status);
    }
    throw new WhatsappSendPermanentError(errorMessage, status);
  }
  return data;
}

async function sendApprovedMessage({ tenantId, messageId }) {
  if (!tenantId) throw new Error("sendApprovedMessage: tenantId required");
  if (!messageId) throw new Error("sendApprovedMessage: messageId required");

  const message = await Message.findOne({
    _id: messageId,
    tenantId,
    channel: "whatsapp",
    direction: "outbound",
  });
  if (!message) return { skipped: true, reason: "message-not-found" };
  if (message.status !== "pending") {
    return {
      skipped: true,
      reason: `message-status-${message.status}`,
      providerMessageId: message.providerMessageId || null,
    };
  }

  const conversation = await Conversation.findOne({
    _id: message.conversationId,
    tenantId,
  });
  if (!conversation) {
    throw new WhatsappSendPermanentError("Conversation not found", 0);
  }

  const recipient = message.providerMeta?.whatsapp?.recipient;
  if (!recipient) {
    throw new WhatsappSendPermanentError("No recipient on message", 0);
  }

  const idempotencyKey = message.providerMeta?.whatsapp?.idempotencyKey;
  if (!idempotencyKey) {
    throw new WhatsappSendPermanentError(
      "Message is missing an idempotency key",
      0,
    );
  }

  const { account, credentials, phoneNumberId } = await getWhatsappCredentials(
    tenantId,
    message.channelAccountId,
  );

  let providerResponse;
  let payload;
  try {
    payload = buildCloudPayload({ recipient, message });
  } catch (err) {
    if (err?.permanent) {
      await Message.updateOne(
        { _id: message._id, tenantId },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            failureReason: err.message?.slice(0, 1900) || "Invalid payload",
          },
        },
      );
    }
    throw err;
  }

  try {
    providerResponse = await postWhatsappSend({
      phoneNumberId,
      accessToken: credentials.accessToken,
      payload,
    });
  } catch (err) {
    const failureReason =
      err?.message?.slice(0, 1900) || "WhatsApp send failed";
    if (err?.permanent) {
      await Message.updateOne(
        { _id: message._id, tenantId },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            failureReason,
          },
        },
      );
      AuditLog.record({
        tenantId,
        action: "whatsapp.send_failed",
        entityType: "message",
        entityId: message._id,
        description: `WhatsApp send failed permanently (${err.status})`,
        metadata: { reason: failureReason, status: err.status },
      });
    }
    throw err;
  }

  const providerMessageId = providerResponse?.messages?.[0]?.id || null;
  const sentAt = new Date();
  const providerThreadId =
    message.providerMeta?.whatsapp?.providerThreadId ||
    conversation.providerThreadId ||
    `${recipient}:${account.providerAccountId}`;

  const updatedMeta = {
    ...(message.providerMeta || {}),
    whatsapp: {
      ...(message.providerMeta?.whatsapp || {}),
      phoneNumberId,
      providerResponse,
      providerThreadId,
      sentAt: sentAt.toISOString(),
    },
  };

  await Message.updateOne(
    { _id: message._id, tenantId },
    {
      $set: {
        status: "sent",
        providerMessageId,
        providerTimestamp: sentAt,
        deliveredAt: sentAt,
        providerMeta: updatedMeta,
      },
    },
  );

  const conversationSet = {
    lastMessageAt: sentAt,
    lastMessageSnippet: String(message.body || "").slice(0, 300),
    lastMessageDirection: "outbound",
  };
  if (!conversation.firstReplyAt) conversationSet.firstReplyAt = sentAt;
  if (!conversation.providerThreadId) {
    conversationSet.providerThreadId = providerThreadId;
  }

  await Conversation.updateOne(
    { _id: conversation._id, tenantId },
    {
      $inc: { messageCount: 1 },
      $set: conversationSet,
    },
  );

  try {
    await incrementUsage(tenantId, "messagesSent", 1);
  } catch (err) {
    logger.error(
      `[WhatsappOutbound] usage meter increment failed: ${err.message}`,
    );
  }

  AuditLog.record({
    tenantId,
    action: "whatsapp.sent",
    entityType: "message",
    entityId: message._id,
    description: `WhatsApp message sent to ${recipient}`,
    metadata: { providerMessageId, phoneNumberId },
  });

  return {
    messageId: String(message._id),
    providerMessageId,
    sentAt: sentAt.toISOString(),
  };
}

export const WhatsappOutboundService = {
  approveDraft,
  composeDraft,
  composeMediaDraft,
  composeTemplateDraft,
  getCustomerServiceWindow,
  rejectDraft,
  sendApprovedMessage,
};

export {
  CUSTOMER_SERVICE_WINDOW_MS,
  WHATSAPP_SEND_JOB_NAME,
  WhatsappSendPermanentError,
  WhatsappSendTransientError,
  normalizeWhatsappIdentifier,
};
