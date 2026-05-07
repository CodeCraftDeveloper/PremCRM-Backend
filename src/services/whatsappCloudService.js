import crypto from "crypto";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import IntegrationEvent from "../models/IntegrationEvent.js";
import { enqueue, QUEUE_NAMES } from "../queue/index.js";
import { TokenVaultService } from "./tokenVaultService.js";
import { ApiError } from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v20.0";

function normalizeToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePhoneNumberId(value) {
  const phoneNumberId = normalizeToken(value);
  if (!/^\d{5,32}$/.test(phoneNumberId)) {
    throw ApiError.badRequest("phoneNumberId must be a numeric WhatsApp phone number ID");
  }
  return phoneNumberId;
}

function normalizeBusinessAccountId(value) {
  const businessAccountId = normalizeToken(value);
  if (!/^\d{5,32}$/.test(businessAccountId)) {
    throw ApiError.badRequest("businessAccountId must be a numeric WhatsApp Business Account ID");
  }
  return businessAccountId;
}

function normalizeDisplayPhoneNumber(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.length > 40) {
    throw ApiError.badRequest("displayPhoneNumber is too long");
  }
  return trimmed;
}

function verifyWebhookChallenge(query = {}) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!expected) {
    return { verified: false, reason: "verification-token-not-configured" };
  }
  if (mode !== "subscribe") {
    return { verified: false, reason: "unsupported-mode" };
  }
  if (!challenge) {
    return { verified: false, reason: "missing-challenge" };
  }
  const provided = Buffer.from(String(token || ""));
  const expectedBuffer = Buffer.from(String(expected));
  if (
    !token ||
    provided.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(provided, expectedBuffer)
  ) {
    return { verified: false, reason: "token-mismatch" };
  }

  return { verified: true, challenge: String(challenge), reason: null };
}

function verifyWebhookSignature({ headers = {}, rawBody }) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = headers["x-hub-signature-256"];

  if (!appSecret) {
    if (process.env.NODE_ENV === "production") {
      return { verified: false, reason: "app-secret-not-configured" };
    }
    return { verified: true, reason: "app-secret-not-configured-dev-bypass" };
  }

  if (!signature || !String(signature).startsWith("sha256=")) {
    return { verified: false, reason: "missing-signature" };
  }
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return { verified: false, reason: "missing-raw-body" };
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = String(signature);
  const sameLength = provided.length === expected.length;
  const matches =
    sameLength &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  return {
    verified: matches,
    reason: matches ? null : "signature-mismatch",
  };
}

function getChanges(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.entry)) {
    return [];
  }

  return body.entry.flatMap((entry) =>
    Array.isArray(entry.changes)
      ? entry.changes.map((change) => ({ entry, change }))
      : [],
  );
}

function buildExternalEventId({ entryId, change, message, status, index }) {
  if (message?.id) return `message:${message.id}`;
  if (status?.id) {
    const statusName = status.status || "unknown";
    const timestamp = status.timestamp || "no-ts";
    return `status:${status.id}:${statusName}:${timestamp}`;
  }
  const field = change?.field || "unknown";
  const phoneNumberId = change?.value?.metadata?.phone_number_id || "unknown-phone";
  return `change:${entryId || "unknown-entry"}:${phoneNumberId}:${field}:${index}`;
}

function extractWhatsappEvents(body) {
  const events = [];
  const changes = getChanges(body);

  changes.forEach(({ entry, change }, changeIndex) => {
    if (change?.field !== "messages") return;
    const value = change.value || {};
    const phoneNumberId = value.metadata?.phone_number_id
      ? String(value.metadata.phone_number_id)
      : null;

    const contacts = new Map(
      Array.isArray(value.contacts)
        ? value.contacts.map((contact) => [String(contact.wa_id), contact])
        : [],
    );

    if (Array.isArray(value.messages)) {
      value.messages.forEach((message, index) => {
        events.push({
          kind: "message",
          phoneNumberId,
          externalEventId: buildExternalEventId({
            entryId: entry.id,
            change,
            message,
            index,
          }),
          message,
          contact: contacts.get(String(message.from)) || null,
          rawChange: change,
        });
      });
    }

    if (Array.isArray(value.statuses)) {
      value.statuses.forEach((status, index) => {
        events.push({
          kind: "status",
          phoneNumberId,
          externalEventId: buildExternalEventId({
            entryId: entry.id,
            change,
            status,
            index: `${changeIndex}-${index}`,
          }),
          status,
          rawChange: change,
        });
      });
    }
  });

  return events;
}

async function connectWhatsappAccount(tenantId, userId, input = {}) {
  const phoneNumberId = normalizePhoneNumberId(input.phoneNumberId);
  const businessAccountId = normalizeBusinessAccountId(input.businessAccountId);
  const accessToken = normalizeToken(input.accessToken);
  if (!accessToken) throw ApiError.badRequest("accessToken is required");

  const displayName =
    normalizeToken(input.displayName) ||
    normalizeDisplayPhoneNumber(input.displayPhoneNumber) ||
    `WhatsApp ${phoneNumberId}`;
  const displayPhoneNumber = normalizeDisplayPhoneNumber(
    input.displayPhoneNumber,
  );

  const credentials = TokenVaultService.encryptJson(
    "whatsapp",
    {
      accessToken,
      businessAccountId,
      phoneNumberId,
      graphVersion: GRAPH_VERSION,
    },
    { tenantId },
  );

  const account = await ChannelAccount.findOneAndUpdate(
    {
      tenantId,
      provider: "whatsapp",
      providerAccountId: phoneNumberId,
    },
    {
      $set: {
        displayName,
        status: "connected",
        credentials,
        scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
        providerMeta: {
          whatsapp: {
            businessAccountId,
            phoneNumberId,
            displayPhoneNumber,
            graphVersion: GRAPH_VERSION,
            connectedAt: new Date().toISOString(),
          },
        },
        connectedBy: userId,
        deletedAt: null,
        deletedBy: null,
        lastError: null,
        consecutiveErrors: 0,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  return account;
}

async function getWhatsappAccount(tenantId, accountId) {
  const account = await ChannelAccount.findOne({
    _id: accountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("WhatsApp account not found");
  return account;
}

async function listWhatsappAccounts(tenantId) {
  return ChannelAccount.find({
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  }).sort({ createdAt: -1 });
}

async function disconnectWhatsappAccount(tenantId, accountId, userId) {
  const account = await ChannelAccount.findOneAndUpdate(
    {
      _id: accountId,
      tenantId,
      provider: "whatsapp",
      deletedAt: null,
    },
    {
      $set: {
        status: "disconnected",
        credentials: null,
        deletedAt: new Date(),
        deletedBy: userId,
      },
    },
    { returnDocument: "after" },
  );
  if (!account) throw ApiError.notFound("WhatsApp account not found");
  return account;
}

async function ingestWhatsappWebhook({ body, headers, rawBody }) {
  const signature = verifyWebhookSignature({ headers, rawBody });
  if (!signature.verified) {
    return {
      accepted: false,
      statusCode: 401,
      reason: signature.reason,
      events: [],
    };
  }

  const parsedEvents = extractWhatsappEvents(body);
  if (!parsedEvents.length) {
    return {
      accepted: true,
      statusCode: 200,
      reason: "no-message-events",
      events: [],
    };
  }

  const results = [];

  for (const parsed of parsedEvents) {
    const existing = await IntegrationEvent.findOne({
      provider: "whatsapp",
      externalEventId: parsed.externalEventId,
    }).lean();
    if (existing) {
      results.push({ event: existing, deduplicated: true });
      continue;
    }

    const account = parsed.phoneNumberId
      ? await ChannelAccount.findOne({
          provider: "whatsapp",
          providerAccountId: parsed.phoneNumberId,
          deletedAt: null,
        })
          .select("_id tenantId")
          .lean()
      : null;

    const baseDoc = {
      provider: "whatsapp",
      eventType:
        parsed.kind === "status" ? "whatsapp.status" : "whatsapp.message",
      externalEventId: parsed.externalEventId,
      payload: {
        kind: parsed.kind,
        phoneNumberId: parsed.phoneNumberId,
        message: parsed.message || null,
        status: parsed.status || null,
        contact: parsed.contact || null,
        rawChange: parsed.rawChange,
      },
      signatureVerified: true,
    };

    if (!account) {
      const skipped = await IntegrationEvent.create({
        ...baseDoc,
        status: "skipped",
        statusReason: parsed.phoneNumberId
          ? `no-channel-account-for-${parsed.phoneNumberId}`
          : "missing-phone-number-id",
      });
      results.push({ event: skipped.toObject(), deduplicated: false });
      continue;
    }

    const created = await IntegrationEvent.create({
      ...baseDoc,
      tenantId: account.tenantId,
      channelAccountId: account._id,
      status: "received",
    });

    let job = null;
    try {
      job = await enqueue(
        QUEUE_NAMES.WHATSAPP_MESSAGES,
        parsed.kind === "status"
          ? "whatsapp.status.received"
          : "whatsapp.message.received",
        {
          tenantId: String(account.tenantId),
          provider: "whatsapp",
          integrationEventId: String(created._id),
          channelAccountId: String(account._id),
          phoneNumberId: parsed.phoneNumberId,
          kind: parsed.kind,
        },
        { idempotencyKey: `whatsapp:${parsed.externalEventId}` },
      );
    } catch (err) {
      logger.error(
        `Failed to enqueue whatsapp.messages job for event ${created._id}: ${
          err?.message || err
        }`,
      );
    }

    if (job) {
      await IntegrationEvent.updateOne(
        { _id: created._id },
        {
          $set: {
            status: "enqueued",
            enqueuedJobId: String(job.id || ""),
            enqueuedAt: new Date(),
          },
        },
      );
      created.status = "enqueued";
      created.enqueuedJobId = String(job.id || "");
    }

    results.push({ event: created.toObject(), deduplicated: false, job });
  }

  return {
    accepted: true,
    statusCode: 200,
    events: results,
  };
}

export const WhatsappCloudService = {
  connectWhatsappAccount,
  disconnectWhatsappAccount,
  extractWhatsappEvents,
  getWhatsappAccount,
  ingestWhatsappWebhook,
  listWhatsappAccounts,
  verifyWebhookChallenge,
  verifyWebhookSignature,
};
