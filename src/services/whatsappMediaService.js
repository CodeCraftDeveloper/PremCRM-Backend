import path from "path";
import AuditLog from "../models/AuditLog.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import Message from "../models/inbox/Message.js";
import { uploadToS3 } from "../config/s3.js";
import { TokenVaultService } from "./tokenVaultService.js";
import { setStorageBytes } from "./usageMeterService.js";
import logger from "../utils/logger.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v20.0";

/**
 * Job name for the BullMQ download task. Routed inside
 * `whatsappMessageProcessor.js`.
 */
export const WHATSAPP_MEDIA_DOWNLOAD_JOB_NAME = "whatsapp.media.download";

/**
 * Content types on `Message` that carry binary media attachments.
 */
const MEDIA_CONTENT_TYPES = new Set(["image", "video", "audio", "document"]);

class WhatsappMediaPermanentError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "WhatsappMediaPermanentError";
    this.permanent = true;
    this.status = status;
  }
}

class WhatsappMediaTransientError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "WhatsappMediaTransientError";
    this.permanent = false;
    this.status = status;
  }
}

function classifyHttpError(status, message) {
  if (status === 429 || status >= 500) {
    return new WhatsappMediaTransientError(message, status);
  }
  return new WhatsappMediaPermanentError(message, status);
}

function inferExtension({ mimeType, filename }) {
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  if (!mimeType) return "";
  const mt = String(mimeType).toLowerCase();
  if (mt.includes("jpeg")) return ".jpg";
  if (mt.includes("png")) return ".png";
  if (mt.includes("gif")) return ".gif";
  if (mt.includes("webp")) return ".webp";
  if (mt.includes("mp4")) return ".mp4";
  if (mt.includes("3gpp")) return ".3gp";
  if (mt.includes("mpeg")) return ".mp3";
  if (mt.includes("ogg")) return ".ogg";
  if (mt.includes("amr")) return ".amr";
  if (mt.includes("pdf")) return ".pdf";
  if (mt.includes("msword")) return ".doc";
  if (mt.includes("officedocument.wordprocessingml")) return ".docx";
  if (mt.includes("ms-excel")) return ".xls";
  if (mt.includes("officedocument.spreadsheetml")) return ".xlsx";
  if (mt.includes("plain")) return ".txt";
  return "";
}

/**
 * Best-effort access-token decrypt for a WhatsApp ChannelAccount. Throws
 * a `WhatsappMediaPermanentError` for any fail-closed condition (deleted
 * account, disconnected, missing credentials) — those will not improve
 * with retries.
 */
async function getWhatsappAccessToken({ tenantId, channelAccountId }) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  }).select("+credentials");

  if (!account) {
    throw new WhatsappMediaPermanentError(
      "WhatsApp channel account not found",
      0,
    );
  }
  if (account.status !== "connected") {
    throw new WhatsappMediaPermanentError(
      `WhatsApp account is not connected (status=${account.status})`,
      0,
    );
  }
  if (!account.credentials) {
    throw new WhatsappMediaPermanentError(
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
    throw new WhatsappMediaPermanentError(
      "WhatsApp access token is missing",
      0,
    );
  }
  return { account, accessToken: credentials.accessToken };
}

async function fetchMediaMetadata({ accessToken, providerMediaId }) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    providerMediaId,
  )}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status;
    const message =
      data?.error?.message ||
      data?.error?.error_data?.details ||
      `WhatsApp media metadata fetch failed (HTTP ${status})`;
    throw classifyHttpError(status, message);
  }
  if (!data?.url) {
    throw new WhatsappMediaPermanentError(
      "WhatsApp media metadata response missing url",
      0,
    );
  }
  return data;
}

async function fetchMediaBytes({ accessToken, mediaUrl }) {
  const response = await fetch(mediaUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const status = response.status;
    const message = `WhatsApp media bytes fetch failed (HTTP ${status})`;
    throw classifyHttpError(status, message);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType =
    response.headers.get?.("content-type") ||
    response.headers.get?.("Content-Type") ||
    null;
  return { buffer, mimeType };
}

/**
 * Download a single inbound WhatsApp media attachment to S3.
 *
 * Idempotency contract:
 *   - If `Message.attachments[attachmentIndex].storageKey` is already
 *     populated, the call is a no-op and returns `{skipped: true,
 *     reason: "already-downloaded"}`.
 *   - Re-runs after a partial failure (metadata fetched, bytes failed,
 *     etc.) re-fetch the Graph media URL because Cloud API URLs are
 *     short-lived signed URLs and cannot be cached.
 *
 * Failure handling:
 *   - 4xx from Graph → `WhatsappMediaPermanentError` and the attachment
 *     is marked `failureReason` on the Message.
 *   - 429 / 5xx → `WhatsappMediaTransientError` so BullMQ retries under
 *     the queue's standard retry policy.
 */
async function downloadInboundMedia({
  tenantId,
  messageId,
  attachmentIndex = 0,
}) {
  if (!tenantId) throw new Error("downloadInboundMedia: tenantId required");
  if (!messageId) throw new Error("downloadInboundMedia: messageId required");

  const message = await Message.findOne({
    _id: messageId,
    tenantId,
    channel: "whatsapp",
    direction: "inbound",
  });
  if (!message) {
    return { skipped: true, reason: "message-not-found" };
  }
  if (!MEDIA_CONTENT_TYPES.has(message.contentType)) {
    return { skipped: true, reason: `non-media-content-${message.contentType}` };
  }

  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];
  const attachment = attachments[attachmentIndex];
  if (!attachment) {
    return { skipped: true, reason: "attachment-not-found" };
  }
  if (attachment.storageKey) {
    return { skipped: true, reason: "already-downloaded" };
  }
  if (!attachment.providerMediaId) {
    return { skipped: true, reason: "missing-provider-media-id" };
  }

  let accessToken;
  try {
    ({ accessToken } = await getWhatsappAccessToken({
      tenantId,
      channelAccountId: message.channelAccountId,
    }));
  } catch (err) {
    if (err?.permanent) {
      await markAttachmentFailed({
        tenantId,
        messageId: message._id,
        attachmentIndex,
        reason: err.message,
      });
    }
    throw err;
  }

  let metadata;
  try {
    metadata = await fetchMediaMetadata({
      accessToken,
      providerMediaId: attachment.providerMediaId,
    });
  } catch (err) {
    if (err?.permanent) {
      await markAttachmentFailed({
        tenantId,
        messageId: message._id,
        attachmentIndex,
        reason: err.message,
      });
      AuditLog.record({
        tenantId,
        action: "whatsapp.media_download_failed",
        entityType: "message",
        entityId: message._id,
        description: `WhatsApp media metadata fetch failed permanently (HTTP ${err.status})`,
        metadata: {
          providerMediaId: attachment.providerMediaId,
          attachmentIndex,
          status: err.status,
        },
      });
    }
    throw err;
  }

  let bytes;
  try {
    bytes = await fetchMediaBytes({
      accessToken,
      mediaUrl: metadata.url,
    });
  } catch (err) {
    if (err?.permanent) {
      await markAttachmentFailed({
        tenantId,
        messageId: message._id,
        attachmentIndex,
        reason: err.message,
      });
      AuditLog.record({
        tenantId,
        action: "whatsapp.media_download_failed",
        entityType: "message",
        entityId: message._id,
        description: `WhatsApp media bytes fetch failed permanently (HTTP ${err.status})`,
        metadata: {
          providerMediaId: attachment.providerMediaId,
          attachmentIndex,
          status: err.status,
        },
      });
    }
    throw err;
  }

  const resolvedMime =
    attachment.mimeType ||
    metadata.mime_type ||
    bytes.mimeType ||
    "application/octet-stream";
  const baseName =
    attachment.filename ||
    `${attachment.providerMediaId}${inferExtension({
      mimeType: resolvedMime,
      filename: attachment.filename,
    })}` ||
    attachment.providerMediaId;

  let upload;
  try {
    upload = await uploadToS3(
      bytes.buffer,
      baseName,
      resolvedMime,
      `whatsapp/${String(tenantId)}/${String(message._id)}`,
    );
  } catch (err) {
    // S3 errors are treated as transient — the BullMQ retry will re-fetch
    // the media URL (Graph signs them with a short TTL) and retry the
    // upload. We do not mark the attachment failed here because the
    // operator can still recover.
    throw new WhatsappMediaTransientError(
      `S3 upload failed: ${err?.message || "unknown"}`,
      0,
    );
  }

  const sizeBytes = Number.isFinite(metadata.file_size)
    ? Number(metadata.file_size)
    : bytes.buffer.length;

  const updatePath = `attachments.${attachmentIndex}`;
  await Message.updateOne(
    { _id: message._id, tenantId },
    {
      $set: {
        [`${updatePath}.storageKey`]: upload.key,
        [`${updatePath}.mimeType`]: resolvedMime,
        [`${updatePath}.sizeBytes`]: sizeBytes,
        [`${updatePath}.filename`]: baseName,
      },
    },
  );

  try {
    if (sizeBytes > 0) {
      await setStorageBytes(tenantId, sizeBytes);
    }
  } catch (err) {
    logger.error(
      `[WhatsappMedia] storage gauge increment failed: ${err?.message || err}`,
    );
  }

  AuditLog.record({
    tenantId,
    action: "whatsapp.media_downloaded",
    entityType: "message",
    entityId: message._id,
    description: `WhatsApp media downloaded to S3 (${resolvedMime}, ${sizeBytes} bytes)`,
    metadata: {
      providerMediaId: attachment.providerMediaId,
      attachmentIndex,
      storageKey: upload.key,
      sizeBytes,
      mimeType: resolvedMime,
    },
  });

  return {
    messageId: String(message._id),
    attachmentIndex,
    storageKey: upload.key,
    mimeType: resolvedMime,
    sizeBytes,
  };
}

async function markAttachmentFailed({
  tenantId,
  messageId,
  attachmentIndex,
  reason,
}) {
  const truncated = String(reason || "WhatsApp media download failed").slice(
    0,
    1900,
  );
  await Message.updateOne(
    { _id: messageId, tenantId },
    {
      $set: {
        [`providerMeta.whatsapp.mediaDownload.${attachmentIndex}`]: {
          status: "failed",
          reason: truncated,
          failedAt: new Date(),
        },
      },
    },
  );
}

export const WhatsappMediaService = {
  downloadInboundMedia,
  WHATSAPP_MEDIA_DOWNLOAD_JOB_NAME,
  MEDIA_CONTENT_TYPES,
};

export {
  WhatsappMediaPermanentError,
  WhatsappMediaTransientError,
};
