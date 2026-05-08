import crypto from "crypto";
import ApprovalRequest from "../models/ApprovalRequest.js";
import AuditLog from "../models/AuditLog.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import Conversation from "../models/inbox/Conversation.js";
import Message from "../models/inbox/Message.js";
import { ApiError } from "../utils/apiResponse.js";
import { GoogleOAuthService } from "./googleOAuthService.js";
import { incrementUsage } from "./usageMeterService.js";
import logger from "../utils/logger.js";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_REFERENCES_HEADERS = 10;

class GmailSendPermanentError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GmailSendPermanentError";
    this.permanent = true;
    this.status = status;
  }
}

class GmailSendTransientError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GmailSendTransientError";
    this.permanent = false;
    this.status = status;
  }
}

function genIdempotencyKey() {
  return crypto.randomBytes(16).toString("hex");
}

function isEmail(value) {
  return (
    typeof value === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

function normalizeRecipients(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out = [];
  for (const raw of list) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    if (!isEmail(trimmed)) {
      throw ApiError.badRequest(`Invalid email address: ${trimmed}`);
    }
    out.push(trimmed.toLowerCase());
  }
  return out;
}

/**
 * Encode a header value that may contain non-ASCII characters using
 * RFC 2047 base64 encoded-word syntax.
 */
function encodeHeader(value) {
  if (!value) return "";
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

function escapeHeaderText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Look up the most recent message in the conversation that has a Gmail
 * `Message-Id` header recorded.  Used to thread replies via `In-Reply-To`
 * and accumulate `References`.
 */
async function findThreadAnchor(tenantId, conversationId) {
  const candidates = await Message.find({
    tenantId,
    conversationId,
    "providerMeta.gmail.messageIdHeader": { $type: "string" },
  })
    .sort({ providerTimestamp: -1, createdAt: -1 })
    .limit(MAX_REFERENCES_HEADERS)
    .select("providerMeta providerTimestamp createdAt")
    .lean();
  if (!candidates.length) return null;

  const newest = candidates[0];
  const refs = candidates
    .map((m) => m?.providerMeta?.gmail?.messageIdHeader)
    .filter(Boolean);

  return {
    inReplyTo: newest.providerMeta?.gmail?.messageIdHeader || null,
    references: refs,
    threadId: newest.providerMeta?.gmail?.threadId || null,
  };
}

function buildMessageIdHeader(idempotencyKey) {
  const host =
    process.env.GMAIL_MESSAGE_ID_HOST || "outbound.orbinest.local";
  return `<${idempotencyKey}@${host}>`;
}

/**
 * Build an RFC 5322 message body (plain text, optional HTML) and return
 * the base64url-encoded form Gmail's `messages.send` expects.
 */
function buildRawMessage({
  fromAddress,
  fromName,
  to,
  cc,
  bcc,
  subject,
  body,
  htmlBody,
  inReplyTo,
  references,
  messageIdHeader,
}) {
  const headers = [];
  const fromValue = fromName
    ? `${encodeHeader(fromName)} <${fromAddress}>`
    : fromAddress;
  headers.push(`From: ${escapeHeaderText(fromValue)}`);
  headers.push(`To: ${escapeHeaderText(to.join(", "))}`);
  if (cc?.length) headers.push(`Cc: ${escapeHeaderText(cc.join(", "))}`);
  if (bcc?.length) headers.push(`Bcc: ${escapeHeaderText(bcc.join(", "))}`);
  headers.push(`Subject: ${encodeHeader(escapeHeaderText(subject || ""))}`);
  headers.push(`Message-Id: ${messageIdHeader}`);
  headers.push("MIME-Version: 1.0");
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references?.length) {
    headers.push(`References: ${references.join(" ")}`);
  }

  let bodyBlock;
  if (htmlBody) {
    const boundary = `=_orbinest_${crypto.randomBytes(8).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const text = body || "";
    bodyBlock =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 7bit\r\n\r\n` +
      `${text}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 7bit\r\n\r\n` +
      `${htmlBody}\r\n` +
      `--${boundary}--`;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 7bit");
    bodyBlock = body || "";
  }

  const raw = `${headers.join("\r\n")}\r\n\r\n${bodyBlock}`;
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getFreshAccessToken(tenantId, channelAccountId) {
  const credentials = await GoogleOAuthService.getDecryptedGoogleCredentials(
    tenantId,
    channelAccountId,
  );
  const expiresAt = credentials.expiresAt
    ? new Date(credentials.expiresAt).getTime()
    : 0;
  const expiresSoon =
    expiresAt && expiresAt - Date.now() < ACCESS_TOKEN_REFRESH_BUFFER_MS;
  if (!credentials.accessToken || expiresSoon) {
    const refreshed = await GoogleOAuthService.refreshGoogleAccessToken(
      tenantId,
      channelAccountId,
    );
    return refreshed.accessToken;
  }
  return credentials.accessToken;
}

/**
 * Compose an outbound Gmail draft and create the matching ApprovalRequest.
 *
 * Lifecycle:
 *   - Always creates `Message` with status="pending" and a generated
 *     idempotency key persisted on `providerMeta.gmail.idempotencyKey`.
 *   - Always creates an `ApprovalRequest` with status="pending".
 *   - Human auto-approval is intentionally handled by the controller after
 *     compose via `approveDraft({ autoApprove:true })`, so draft persistence
 *     and queue enqueueing keep one auditable path.
 *
 * Returns `{message, approvalRequest}`.
 */
export async function composeDraft({
  tenantId,
  conversationId,
  channelAccountId,
  body = "",
  htmlBody = null,
  subject = null,
  to,
  cc = [],
  bcc = [],
  aiGenerated = false,
  aiRunId = null,
  confidence = null,
  sentByUserId = null,
  metadata = {},
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  if (!conversationId)
    throw ApiError.badRequest("conversationId is required");
  if (!body && !htmlBody) {
    throw ApiError.badRequest("body or htmlBody is required");
  }

  const conversation = await Conversation.findOne({
    _id: conversationId,
    tenantId,
    deletedAt: null,
  });
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (conversation.channel !== "gmail") {
    throw ApiError.badRequest(
      `Conversation channel ${conversation.channel} is not gmail`,
    );
  }

  const resolvedChannelAccountId =
    channelAccountId || conversation.channelAccountId;
  const account = await ChannelAccount.findOne({
    _id: resolvedChannelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("Gmail channel account not found");
  if (account.status !== "connected") {
    throw ApiError.badRequest(
      `Gmail account is not connected (status=${account.status})`,
    );
  }

  let toList = normalizeRecipients(to);
  if (!toList.length) {
    if (conversation.contactIdentityId) {
      const ContactIdentity = (
        await import("../models/inbox/ContactIdentity.js")
      ).default;
      const identity = await ContactIdentity.findOne({
        _id: conversation.contactIdentityId,
        tenantId,
      }).lean();
      if (identity?.providerIdentifier) {
        toList = [String(identity.providerIdentifier).toLowerCase()];
      }
    }
  }
  if (!toList.length) {
    throw ApiError.badRequest("Recipient (to) is required");
  }

  const ccList = normalizeRecipients(cc);
  const bccList = normalizeRecipients(bcc);
  const idempotencyKey = genIdempotencyKey();
  const messageIdHeader = buildMessageIdHeader(idempotencyKey);

  const message = await Message.create({
    tenantId,
    conversationId: conversation._id,
    channelAccountId: account._id,
    channel: "gmail",
    direction: "outbound",
    status: "pending",
    contentType: htmlBody ? "html" : "text",
    body: body || "",
    htmlBody: htmlBody || null,
    subject: subject || conversation.lastMessageSnippet || null,
    senderIdentifier: account.providerAccountId,
    senderName: account.displayName || account.providerAccountId,
    sentByUserId: sentByUserId || null,
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    providerMeta: {
      gmail: {
        idempotencyKey,
        messageIdHeader,
        recipients: { to: toList, cc: ccList, bcc: bccList },
        threadId: conversation.providerThreadId || null,
      },
    },
  });

  const approvalRequest = await ApprovalRequest.create({
    tenantId,
    type: "gmail.send",
    status: "pending",
    relatedEntityType: "message",
    relatedEntityId: message._id,
    summary: subject ? subject.slice(0, 200) : (body || "").slice(0, 200),
    metadata: {
      ...metadata,
      conversationId: String(conversation._id),
      channelAccountId: String(account._id),
      to: toList,
      cc: ccList,
      bcc: bccList,
    },
    aiGenerated: Boolean(aiGenerated),
    aiRunId: aiRunId || null,
    confidence: confidence,
    requestedBy: sentByUserId || null,
  });

  await Message.updateOne(
    { _id: message._id, tenantId },
    { $set: { approvalRequestId: approvalRequest._id } },
  );

  AuditLog.record({
    tenantId,
    userId: sentByUserId || null,
    action: "gmail.draft_created",
    entityType: "message",
    entityId: message._id,
    description: `Gmail draft created for conversation ${conversation._id}`,
    metadata: {
      approvalRequestId: String(approvalRequest._id),
      aiGenerated: Boolean(aiGenerated),
      to: toList,
    },
  });

  return { message, approvalRequest };
}

/**
 * Approve a pending draft and enqueue the send job.
 *
 * Idempotency: BullMQ jobId is the message idempotency key; double clicks
 * do not enqueue twice while the job is resident in Redis.
 */
export async function approveDraft({
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
  if (approval.type !== "gmail.send") {
    throw ApiError.badRequest(
      `Approval request type is ${approval.type}, not gmail.send`,
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
    direction: "outbound",
  });
  if (!message) throw ApiError.notFound("Message not found");
  if (message.status !== "pending") {
    throw ApiError.badRequest(
      `Message status ${message.status} is not pending`,
    );
  }
  const idempotencyKey = message.providerMeta?.gmail?.idempotencyKey;
  if (!idempotencyKey) {
    throw ApiError.internal("Message is missing an idempotency key");
  }

  approval.status = autoApprove ? "auto_approved" : "approved";
  approval.decidedBy = decidedBy || null;
  approval.decidedAt = new Date();
  approval.decisionReason = decisionReason;
  await approval.save();

  await enqueueFn("gmail.sync", "message.send", {
    tenantId: String(tenantId),
    messageId: String(message._id),
    channelAccountId: String(message.channelAccountId),
  }, { idempotencyKey: `gmail.send:${idempotencyKey}` });

  AuditLog.record({
    tenantId,
    userId: decidedBy || null,
    action: autoApprove ? "gmail.auto_approved" : "gmail.approved",
    entityType: "approval_request",
    entityId: approval._id,
    description: `Gmail outbound message approved (message ${message._id})`,
    metadata: { messageId: String(message._id) },
  });

  return { approval, message };
}

/**
 * Reject a pending draft.  Marks the related Message failed so it never
 * leaves pending and is visible in the inbox as a failed draft.
 */
export async function rejectDraft({
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
    action: "gmail.rejected",
    entityType: "approval_request",
    entityId: approval._id,
    description: `Gmail outbound message rejected`,
    metadata: { messageId: message ? String(message._id) : null },
  });

  return { approval, message };
}

async function postGmailSend(accessToken, raw, threadId) {
  const payload = threadId ? { raw, threadId } : { raw };
  const response = await fetch(GMAIL_SEND_URL, {
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
      `Gmail send failed with HTTP ${status}`;
    if (status === 429 || status >= 500) {
      throw new GmailSendTransientError(errorMessage, status);
    }
    throw new GmailSendPermanentError(errorMessage, status);
  }
  return data;
}

/**
 * Send an approved outbound message.  Called by the BullMQ processor.
 *
 * Idempotency: re-checks `Message.status`; if the message has already
 * advanced past `pending` (e.g. an earlier attempt succeeded but the
 * worker crashed before acking), returns without re-sending.
 *
 * On 4xx Gmail errors throws `GmailSendPermanentError` so the processor
 * can convert it into a `NonRetryableError` for the DLQ.
 *
 * On 429 / 5xx throws `GmailSendTransientError` so BullMQ honours the
 * `gmail.sync` retry policy (8 attempts).
 */
export async function sendApprovedMessage({ tenantId, messageId }) {
  if (!tenantId) throw new Error("sendApprovedMessage: tenantId required");
  if (!messageId) throw new Error("sendApprovedMessage: messageId required");

  const message = await Message.findOne({
    _id: messageId,
    tenantId,
    direction: "outbound",
  }).select("+htmlBody");
  if (!message) {
    return { skipped: true, reason: "message-not-found" };
  }
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
    throw new GmailSendPermanentError("Conversation not found", 0);
  }

  const account = await ChannelAccount.findOne({
    _id: message.channelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) {
    throw new GmailSendPermanentError(
      "Gmail channel account not found",
      0,
    );
  }
  if (account.status !== "connected") {
    throw new GmailSendPermanentError(
      `Gmail account is not connected (status=${account.status})`,
      0,
    );
  }

  const recipients = message.providerMeta?.gmail?.recipients || {};
  const to = Array.isArray(recipients.to) ? recipients.to : [];
  const cc = Array.isArray(recipients.cc) ? recipients.cc : [];
  const bcc = Array.isArray(recipients.bcc) ? recipients.bcc : [];
  if (!to.length) {
    throw new GmailSendPermanentError("No recipients on message", 0);
  }

  const idempotencyKey = message.providerMeta?.gmail?.idempotencyKey;
  if (!idempotencyKey) {
    throw new GmailSendPermanentError(
      "Message is missing an idempotency key",
      0,
    );
  }

  const anchor = await findThreadAnchor(tenantId, conversation._id);
  const threadId =
    message.providerMeta?.gmail?.threadId || anchor?.threadId || null;

  const raw = buildRawMessage({
    fromAddress: account.providerAccountId,
    fromName: account.displayName,
    to,
    cc,
    bcc,
    subject: message.subject,
    body: message.body,
    htmlBody: message.htmlBody,
    inReplyTo: anchor?.inReplyTo || null,
    references: anchor?.references || [],
    messageIdHeader:
      message.providerMeta?.gmail?.messageIdHeader ||
      buildMessageIdHeader(idempotencyKey),
  });

  const accessToken = await getFreshAccessToken(tenantId, account._id);

  let providerResponse;
  try {
    providerResponse = await postGmailSend(accessToken, raw, threadId);
  } catch (err) {
    const failureReason = err?.message?.slice(0, 1900) || "Gmail send failed";
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
        action: "gmail.send_failed",
        entityType: "message",
        entityId: message._id,
        description: `Gmail send failed permanently (${err.status})`,
        metadata: { reason: failureReason, status: err.status },
      });
    }
    throw err;
  }

  const providerMessageId = providerResponse?.id || null;
  const providerThreadId = providerResponse?.threadId || threadId || null;
  const sentAt = new Date();

  const updatedMeta = {
    ...(message.providerMeta || {}),
    gmail: {
      ...(message.providerMeta?.gmail || {}),
      threadId: providerThreadId,
      messageId: providerMessageId,
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

  if (
    providerThreadId &&
    !conversation.providerThreadId
  ) {
    await Conversation.updateOne(
      { _id: conversation._id, tenantId },
      { $set: { providerThreadId: providerThreadId } },
    );
  }

  const snippet = (message.body || message.subject || "").slice(0, 300);
  const conversationUpdate = {
    $inc: { messageCount: 1 },
    $set: {
      lastMessageAt: sentAt,
      lastMessageSnippet: snippet,
      lastMessageDirection: "outbound",
    },
  };
  if (!conversation.firstReplyAt) {
    conversationUpdate.$set.firstReplyAt = sentAt;
  }
  await Conversation.updateOne(
    { _id: conversation._id, tenantId },
    conversationUpdate,
  );

  try {
    await incrementUsage(tenantId, "messagesSent", 1);
  } catch (err) {
    logger.error(
      `[GmailOutbound] usage meter increment failed: ${err.message}`,
    );
  }

  AuditLog.record({
    tenantId,
    action: "gmail.sent",
    entityType: "message",
    entityId: message._id,
    description: `Gmail message sent to ${to.join(", ")}`,
    metadata: {
      providerMessageId,
      providerThreadId,
    },
  });

  return {
    messageId: String(message._id),
    providerMessageId,
    providerThreadId,
    sentAt: sentAt.toISOString(),
  };
}

export const GmailOutboundService = {
  composeDraft,
  approveDraft,
  rejectDraft,
  sendApprovedMessage,
};

export {
  GmailSendPermanentError,
  GmailSendTransientError,
  buildRawMessage,
  findThreadAnchor,
  normalizeRecipients,
};
