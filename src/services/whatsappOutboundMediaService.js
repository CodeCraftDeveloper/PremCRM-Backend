import path from "path";
import AuditLog from "../models/AuditLog.js";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import { getFromS3, uploadToS3 } from "../config/s3.js";
import { TokenVaultService } from "./tokenVaultService.js";
import { setStorageBytes } from "./usageMeterService.js";
import logger from "../utils/logger.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v20.0";

/**
 * WhatsApp Cloud API supported outbound media types. The Cloud API
 * documents these four content types and their supported MIME types
 * at:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#supported-media-types
 */
export const OUTBOUND_MEDIA_TYPES = Object.freeze([
  "image",
  "video",
  "audio",
  "document",
]);

/**
 * Per-type supported MIME types. This is a defensive subset of the Cloud
 * API matrix — Meta accepts more, but we surface validation errors for
 * obviously-wrong combinations (e.g. uploading a PDF as `image`).
 */
const ALLOWED_MIME_BY_TYPE = Object.freeze({
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/3gpp", "video/3gp"]),
  audio: new Set([
    "audio/aac",
    "audio/mp4",
    "audio/mpeg",
    "audio/amr",
    "audio/ogg",
    "audio/ogg; codecs=opus",
  ]),
  document: new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
  ]),
});

class WhatsappMediaUploadPermanentError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "WhatsappMediaUploadPermanentError";
    this.permanent = true;
    this.status = status;
  }
}

class WhatsappMediaUploadTransientError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "WhatsappMediaUploadTransientError";
    this.permanent = false;
    this.status = status;
  }
}

function classifyHttpError(status, message) {
  if (status === 429 || status >= 500) {
    return new WhatsappMediaUploadTransientError(message, status);
  }
  return new WhatsappMediaUploadPermanentError(message, status);
}

function inferExtension({ mimeType, filename }) {
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  if (!mimeType) return "";
  const mt = String(mimeType).toLowerCase();
  if (mt.includes("jpeg") || mt.includes("jpg")) return ".jpg";
  if (mt.includes("png")) return ".png";
  if (mt.includes("webp")) return ".webp";
  if (mt.includes("mp4")) return ".mp4";
  if (mt.includes("3gp")) return ".3gp";
  if (mt.includes("mpeg")) return ".mp3";
  if (mt.includes("aac")) return ".aac";
  if (mt.includes("amr")) return ".amr";
  if (mt.includes("ogg")) return ".ogg";
  if (mt.includes("pdf")) return ".pdf";
  if (mt.includes("msword")) return ".doc";
  if (mt.includes("officedocument.wordprocessingml")) return ".docx";
  if (mt.includes("ms-excel")) return ".xls";
  if (mt.includes("officedocument.spreadsheetml")) return ".xlsx";
  if (mt.includes("plain")) return ".txt";
  return "";
}

function assertMediaTypeAndMime(mediaType, mimeType) {
  if (!OUTBOUND_MEDIA_TYPES.includes(mediaType)) {
    throw new WhatsappMediaUploadPermanentError(
      `Unsupported media type "${mediaType}"`,
      0,
    );
  }
  if (!mimeType) {
    throw new WhatsappMediaUploadPermanentError(
      "mimeType is required for outbound media",
      0,
    );
  }
  const allowed = ALLOWED_MIME_BY_TYPE[mediaType];
  const baseMime = String(mimeType).split(";")[0].trim().toLowerCase();
  // Accept either an exact match or a parameter-bearing variant of an
  // allowed base mime (e.g. "audio/ogg; codecs=opus").
  if (!allowed.has(baseMime) && !allowed.has(String(mimeType).toLowerCase())) {
    throw new WhatsappMediaUploadPermanentError(
      `MIME type "${mimeType}" is not allowed for media type "${mediaType}"`,
      0,
    );
  }
}

/**
 * Resolves a binary source to an in-memory `{buffer, mimeType, filename}`.
 *
 * Two source modes are supported:
 *   - `{kind: "buffer", buffer, mimeType, filename}` — admin uploaded a
 *     fresh attachment (multer memory storage).
 *   - `{kind: "s3", storageKey, mimeType?, filename?}` — re-attach an
 *     already-stored asset (typically an inbound media downloaded by
 *     P6-004a). The mimeType / filename hints are honoured if supplied.
 */
async function resolveSourceBuffer(source) {
  if (!source || typeof source !== "object") {
    throw new WhatsappMediaUploadPermanentError(
      "Outbound media source is required",
      0,
    );
  }
  if (source.kind === "buffer") {
    if (!Buffer.isBuffer(source.buffer)) {
      throw new WhatsappMediaUploadPermanentError(
        "buffer source requires a Node Buffer",
        0,
      );
    }
    return {
      buffer: source.buffer,
      mimeType: source.mimeType || "application/octet-stream",
      filename: source.filename || "upload.bin",
    };
  }
  if (source.kind === "s3") {
    if (!source.storageKey) {
      throw new WhatsappMediaUploadPermanentError(
        "s3 source requires a storageKey",
        0,
      );
    }
    let object;
    try {
      object = await getFromS3(source.storageKey);
    } catch (err) {
      // S3 read failures are transient — the object should still exist;
      // upstream may have rate-limited us.
      throw new WhatsappMediaUploadTransientError(
        `S3 read failed: ${err?.message || "unknown"}`,
        0,
      );
    }
    return {
      buffer: object.buffer,
      mimeType: source.mimeType || object.contentType || "application/octet-stream",
      filename:
        source.filename ||
        path.basename(source.storageKey) ||
        `attachment${inferExtension({
          mimeType: source.mimeType || object.contentType,
        })}`,
    };
  }
  throw new WhatsappMediaUploadPermanentError(
    `Unknown source kind "${source.kind}"`,
    0,
  );
}

async function getWhatsappAccessToken({ tenantId, channelAccountId }) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  }).select("+credentials");

  if (!account) {
    throw new WhatsappMediaUploadPermanentError(
      "WhatsApp channel account not found",
      0,
    );
  }
  if (account.status !== "connected") {
    throw new WhatsappMediaUploadPermanentError(
      `WhatsApp account is not connected (status=${account.status})`,
      0,
    );
  }
  if (!account.credentials) {
    throw new WhatsappMediaUploadPermanentError(
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
    throw new WhatsappMediaUploadPermanentError(
      "WhatsApp access token is missing",
      0,
    );
  }
  const phoneNumberId =
    credentials.phoneNumberId ||
    account.providerMeta?.whatsapp?.phoneNumberId ||
    account.providerAccountId;
  if (!phoneNumberId) {
    throw new WhatsappMediaUploadPermanentError(
      "WhatsApp phoneNumberId is missing",
      0,
    );
  }
  return { account, accessToken: credentials.accessToken, phoneNumberId };
}

async function postMediaUpload({ phoneNumberId, accessToken, buffer, mimeType, filename }) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    phoneNumberId,
  )}/media`;

  // Built-in undici FormData / Blob (Node 18+). Avoids adding a new
  // form-data npm dependency.
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", String(mimeType).split(";")[0].trim());
  // Convert the Node Buffer to a Uint8Array view that File can consume.
  const view = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const file = new File([view], filename, { type: mimeType });
  form.append("file", file, filename);

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status;
    const message =
      data?.error?.message ||
      data?.error?.error_data?.details ||
      `WhatsApp media upload failed (HTTP ${status})`;
    throw classifyHttpError(status, message);
  }
  if (!data?.id) {
    throw new WhatsappMediaUploadPermanentError(
      "WhatsApp media upload response missing id",
      0,
    );
  }
  return data;
}

/**
 * Persist the buffer to S3 so a successful Cloud API upload also gives
 * us a tenant-owned copy. Reuses the inbound `whatsapp/{tenantId}/...`
 * key prefix so a single asset can be referenced by both inbound history
 * and outbound replies.
 *
 * Failures here are best-effort: we already uploaded to Meta successfully
 * so we still want to return the providerMediaId. We log the error and
 * continue.
 */
async function persistOutboundCopy({ tenantId, buffer, mimeType, filename }) {
  try {
    const baseName =
      filename ||
      `outbound${inferExtension({ mimeType, filename })}`;
    const upload = await uploadToS3(
      buffer,
      baseName,
      mimeType,
      `whatsapp/${String(tenantId)}/outbound`,
    );
    return upload?.key || null;
  } catch (err) {
    logger.warn(
      `[WhatsappOutboundMedia] outbound S3 copy failed: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Upload an outbound WhatsApp media asset to Cloud API and return the
 * Meta media id (`providerMediaId`). The returned id is used in the
 * subsequent send-by-id payload (`type: "image"`, `image: {id}` …).
 *
 * Failure handling mirrors the inbound media download:
 *   - Graph 4xx → `WhatsappMediaUploadPermanentError`
 *   - Graph 429/5xx → `WhatsappMediaUploadTransientError`
 *   - S3 read errors on `s3` source → transient (allow retry)
 *
 * Best-effort behaviour:
 *   - Persists a tenant-owned S3 copy at `whatsapp/{tenantId}/outbound/...`
 *   - Bumps the `storageBytes` gauge (high-water mark).
 *   - Audits `whatsapp.media_uploaded` on success and
 *     `whatsapp.media_upload_failed` on permanent failure.
 */
async function uploadOutboundMedia({
  tenantId,
  channelAccountId,
  mediaType,
  source,
  filename: filenameOverride = null,
  mimeType: mimeTypeOverride = null,
  caption = null,
}) {
  if (!tenantId) throw new Error("uploadOutboundMedia: tenantId required");
  if (!channelAccountId)
    throw new Error("uploadOutboundMedia: channelAccountId required");

  const resolved = await resolveSourceBuffer(source);
  const mimeType = mimeTypeOverride || resolved.mimeType;
  const filename = filenameOverride || resolved.filename;
  const buffer = resolved.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new WhatsappMediaUploadPermanentError(
      "Outbound media buffer is empty",
      0,
    );
  }

  assertMediaTypeAndMime(mediaType, mimeType);

  const { accessToken, phoneNumberId } = await getWhatsappAccessToken({
    tenantId,
    channelAccountId,
  });

  let providerResponse;
  try {
    providerResponse = await postMediaUpload({
      phoneNumberId,
      accessToken,
      buffer,
      mimeType,
      filename,
    });
  } catch (err) {
    if (err?.permanent) {
      AuditLog.record({
        tenantId,
        action: "whatsapp.media_upload_failed",
        entityType: "message",
        entityId: null,
        description: `WhatsApp media upload failed permanently (HTTP ${err.status})`,
        metadata: {
          channelAccountId: String(channelAccountId),
          mediaType,
          mimeType,
          filename,
          status: err.status,
          reason: String(err.message || "").slice(0, 1900),
        },
      });
    }
    throw err;
  }

  let storageKey = source?.storageKey || null;
  if (!storageKey) {
    storageKey = await persistOutboundCopy({
      tenantId,
      buffer,
      mimeType,
      filename,
    });
  }

  if (storageKey) {
    try {
      if (buffer.length > 0) {
        await setStorageBytes(tenantId, buffer.length);
      }
    } catch (err) {
      logger.error(
        `[WhatsappOutboundMedia] storage gauge increment failed: ${err?.message || err}`,
      );
    }
  }

  AuditLog.record({
    tenantId,
    action: "whatsapp.media_uploaded",
    entityType: "message",
    entityId: null,
    description: `WhatsApp media uploaded to Cloud API (${mediaType}, ${buffer.length} bytes)`,
    metadata: {
      channelAccountId: String(channelAccountId),
      providerMediaId: providerResponse.id,
      mediaType,
      mimeType,
      filename,
      sizeBytes: buffer.length,
      storageKey: storageKey || null,
      hasCaption: Boolean(caption),
    },
  });

  return {
    providerMediaId: String(providerResponse.id),
    mediaType,
    mimeType,
    filename,
    sizeBytes: buffer.length,
    storageKey: storageKey || null,
  };
}

export const WhatsappOutboundMediaService = {
  uploadOutboundMedia,
  ALLOWED_MIME_BY_TYPE,
  OUTBOUND_MEDIA_TYPES,
};

export {
  WhatsappMediaUploadPermanentError,
  WhatsappMediaUploadTransientError,
};
