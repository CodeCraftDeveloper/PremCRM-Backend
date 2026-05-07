import ChannelAccount from "../models/inbox/ChannelAccount.js";
import ContactIdentity from "../models/inbox/ContactIdentity.js";
import Conversation from "../models/inbox/Conversation.js";
import Message from "../models/inbox/Message.js";
import IntegrationEvent from "../models/IntegrationEvent.js";
import { ApiError } from "../utils/apiResponse.js";

function normalizeWhatsappIdentifier(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function getMessageTimestamp(message) {
  if (!message?.timestamp) return new Date();
  const seconds = Number(message.timestamp);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function mapContent(message = {}) {
  const type = message.type || "system";
  switch (type) {
    case "text":
      return {
        contentType: "text",
        body: message.text?.body || "",
        attachments: [],
      };
    case "image":
    case "video":
    case "audio":
    case "document": {
      const media = message[type] || {};
      return {
        contentType: type,
        body: media.caption || media.filename || `[${type}]`,
        attachments: [
          {
            filename: media.filename || null,
            mimeType: media.mime_type || null,
            providerMediaId: media.id || null,
          },
        ].filter((attachment) => attachment.providerMediaId || attachment.filename),
      };
    }
    case "location":
      return {
        contentType: "location",
        body: JSON.stringify(message.location || {}),
        attachments: [],
      };
    case "contacts":
      return {
        contentType: "contact_card",
        body: JSON.stringify(message.contacts || []),
        attachments: [],
      };
    case "interactive":
      return {
        contentType: "interactive",
        body:
          message.interactive?.button_reply?.title ||
          message.interactive?.list_reply?.title ||
          JSON.stringify(message.interactive || {}),
        attachments: [],
      };
    case "reaction":
      return {
        contentType: "reaction",
        body: message.reaction?.emoji || "",
        attachments: [],
      };
    default:
      return {
        contentType: "system",
        body: JSON.stringify(message[type] || message),
        attachments: [],
      };
  }
}

function mapStatus(status) {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

async function updateDeliveryStatus({ tenantId, channelAccountId, status }) {
  const nextStatus = mapStatus(status?.status);
  if (!nextStatus || !status?.id) {
    return { updated: false, reason: "unsupported-status" };
  }

  const update = {
    status: nextStatus,
    "providerMeta.whatsapp.lastStatus": status,
  };
  if (nextStatus === "delivered") update.deliveredAt = new Date();
  if (nextStatus === "read") update.readAt = new Date();
  if (nextStatus === "failed") {
    update.failedAt = new Date();
    update.failureReason =
      status.errors?.[0]?.title || status.errors?.[0]?.message || "WhatsApp send failed";
  }

  const result = await Message.updateOne(
    {
      tenantId,
      channelAccountId,
      channel: "whatsapp",
      providerMessageId: status.id,
    },
    { $set: update },
  );

  return { updated: result.modifiedCount > 0, status: nextStatus };
}

async function importWhatsappMessage({ tenantId, channelAccountId, payload }) {
  const message = payload?.message;
  if (!message?.id) throw ApiError.badRequest("WhatsApp message id is required");

  const existing = await Message.findOne({
    tenantId,
    channelAccountId,
    providerMessageId: message.id,
  }).lean();
  if (existing) return { created: false, message: existing };

  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "whatsapp",
    deletedAt: null,
  }).lean();
  if (!account) throw ApiError.notFound("WhatsApp channel account not found");

  const from = normalizeWhatsappIdentifier(message.from);
  if (!from) throw ApiError.badRequest("WhatsApp sender identifier is required");

  const contact = payload.contact || {};
  const displayName =
    contact.profile?.name || contact.name?.formatted_name || from;
  const providerTimestamp = getMessageTimestamp(message);

  const identity = await ContactIdentity.findOneAndUpdate(
    {
      tenantId,
      provider: "whatsapp",
      providerIdentifier: from,
    },
    {
      $set: {
        displayName,
        lastSeenAt: providerTimestamp,
        providerMeta: {
          whatsapp: {
            waId: contact.wa_id || message.from,
            profile: contact.profile || null,
          },
        },
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  const providerThreadId = `${from}:${account.providerAccountId}`;
  const content = mapContent(message);
  const snippet = String(content.body || "").slice(0, 300);

  let conversation = await Conversation.findOne({
    tenantId,
    channelAccountId,
    providerThreadId,
    deletedAt: null,
  });

  if (!conversation) {
    conversation = await Conversation.create({
      tenantId,
      channelAccountId,
      channel: "whatsapp",
      providerThreadId,
      contactId: identity.contactId || null,
      contactIdentityId: identity._id,
      participantName: displayName,
      status: "open",
      firstMessageAt: providerTimestamp,
      firstUnrepliedAt: providerTimestamp,
    });
  }

  try {
    const created = await Message.create({
      tenantId,
      conversationId: conversation._id,
      channelAccountId,
      channel: "whatsapp",
      direction: "inbound",
      status: "sent",
      providerMessageId: message.id,
      contentType: content.contentType,
      body: content.body,
      attachments: content.attachments,
      senderName: displayName,
      senderIdentifier: from,
      contactIdentityId: identity._id,
      providerTimestamp,
      providerMeta: {
        whatsapp: {
          type: message.type || null,
          context: message.context || null,
          raw: message,
        },
      },
    });

    const update = {
      $set: {
        participantName: conversation.participantName || displayName,
        contactIdentityId: conversation.contactIdentityId || identity._id,
        contactId: conversation.contactId || identity.contactId || null,
        status: "open",
        snoozedUntil: null,
        lastMessageAt: providerTimestamp,
        lastMessageSnippet: snippet,
        lastMessageDirection: "inbound",
      },
      $inc: { messageCount: 1, unreadCount: 1 },
    };
    if (!conversation.firstMessageAt) update.$set.firstMessageAt = providerTimestamp;
    if (!conversation.firstUnrepliedAt && !conversation.firstReplyAt) {
      update.$set.firstUnrepliedAt = providerTimestamp;
    }

    await Conversation.updateOne({ _id: conversation._id, tenantId }, update);
    await ChannelAccount.updateOne(
      { _id: channelAccountId, tenantId },
      {
        $set: { lastSyncAt: new Date(), lastError: null, consecutiveErrors: 0 },
      },
    );

    return { created: true, message: created };
  } catch (err) {
    if (err?.code === 11000) {
      const raced = await Message.findOne({
        tenantId,
        channelAccountId,
        providerMessageId: message.id,
      }).lean();
      return { created: false, message: raced };
    }
    throw err;
  }
}

async function processWhatsappIntegrationEvent({ tenantId, integrationEventId }) {
  const event = await IntegrationEvent.findOne({
    _id: integrationEventId,
    tenantId,
    provider: "whatsapp",
  });
  if (!event) throw ApiError.notFound("WhatsApp integration event not found");

  if (event.status === "processed") {
    return { skipped: true, eventId: String(event._id) };
  }

  if (event.eventType === "whatsapp.status") {
    const result = await updateDeliveryStatus({
      tenantId,
      channelAccountId: event.channelAccountId,
      status: event.payload?.status,
    });
    event.status = "processed";
    event.processedAt = new Date();
    event.statusReason = result.updated ? null : result.reason || "message-not-found";
    await event.save();
    return { eventId: String(event._id), provider: "whatsapp", ...result };
  }

  const result = await importWhatsappMessage({
    tenantId,
    channelAccountId: event.channelAccountId,
    payload: event.payload,
  });
  event.status = "processed";
  event.processedAt = new Date();
  event.statusReason = result.created ? null : "duplicate-message";
  await event.save();

  return {
    eventId: String(event._id),
    provider: "whatsapp",
    imported: result.created ? 1 : 0,
    messageId: result.message ? String(result.message._id) : null,
  };
}

export const WhatsappMessageSyncService = {
  importWhatsappMessage,
  mapContent,
  normalizeWhatsappIdentifier,
  processWhatsappIntegrationEvent,
  updateDeliveryStatus,
};
