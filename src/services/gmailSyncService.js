import ChannelAccount from "../models/inbox/ChannelAccount.js";
import Conversation from "../models/inbox/Conversation.js";
import Message from "../models/inbox/Message.js";
import ContactIdentity from "../models/inbox/ContactIdentity.js";
import { GoogleOAuthService } from "./googleOAuthService.js";
import logger from "../utils/logger.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HISTORY_LIST_PAGE_SIZE = 100;
const BOOTSTRAP_MESSAGE_LIMIT = 20;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

class GmailHistoryGoneError extends Error {
  constructor(message = "Gmail history expired (404)") {
    super(message);
    this.name = "GmailHistoryGoneError";
    this.code = "HISTORY_GONE";
  }
}

class GmailNotFoundError extends Error {
  constructor(message = "Gmail resource not found (404)") {
    super(message);
    this.name = "GmailNotFoundError";
    this.code = "NOT_FOUND";
  }
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

async function callGmail(url, accessToken) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    if (url.includes("/history")) throw new GmailHistoryGoneError();
    throw new GmailNotFoundError();
  }
  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gmail API GET ${url} failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

function decodeHeader(headers = [], name) {
  if (!Array.isArray(headers)) return null;
  const lower = name.toLowerCase();
  const found = headers.find((h) => (h?.name || "").toLowerCase() === lower);
  return found?.value || null;
}

const ANGLE_EMAIL_RE = /<([^>]+)>/;
const RAW_EMAIL_RE = /([^\s<>"]+@[^\s<>"]+)/;

export function parseAddress(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  const angle = trimmed.match(ANGLE_EMAIL_RE);
  if (angle) {
    const email = angle[1].trim().toLowerCase();
    const name = trimmed.slice(0, angle.index).trim().replace(/^"|"$/g, "");
    return { email, name: name || null };
  }
  const raw = trimmed.match(RAW_EMAIL_RE);
  if (raw) {
    return { email: raw[1].toLowerCase(), name: null };
  }
  return null;
}

export function parseAddressList(value) {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => parseAddress(entry))
    .filter(Boolean);
}

function decodeBase64Url(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function extractBodies(payload) {
  let textBody = "";
  let htmlBody = "";

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || "";
    const data = part.body?.data;
    if (data) {
      if (mime === "text/plain" && !textBody) textBody = decodeBase64Url(data);
      else if (mime === "text/html" && !htmlBody)
        htmlBody = decodeBase64Url(data);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return { textBody, htmlBody };
}

function snippetFromBody(text, fallback) {
  const source = (text || fallback || "").trim();
  if (!source) return null;
  return source.slice(0, 280);
}

async function upsertContactIdentity({
  tenantId,
  email,
  displayName,
  observedAt,
}) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const update = {
    $setOnInsert: {
      tenantId,
      provider: "email",
      providerIdentifier: lower,
      contactId: null,
      verified: false,
    },
    $set: {
      lastSeenAt: observedAt || new Date(),
    },
  };
  if (displayName) update.$set.displayName = displayName;

  const identity = await ContactIdentity.findOneAndUpdate(
    { tenantId, provider: "email", providerIdentifier: lower },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return identity;
}

async function upsertConversationForThread({
  tenantId,
  channelAccount,
  threadId,
  participant,
  identity,
}) {
  const filter = {
    tenantId,
    channelAccountId: channelAccount._id,
    providerThreadId: threadId,
  };
  const setOnInsert = {
    tenantId,
    channelAccountId: channelAccount._id,
    channel: "gmail",
    providerThreadId: threadId,
    status: "open",
    messageCount: 0,
    unreadCount: 0,
  };
  if (participant?.email) {
    setOnInsert.participantName = participant.name || participant.email;
  }
  if (identity?._id) {
    setOnInsert.contactIdentityId = identity._id;
    if (identity.contactId) setOnInsert.contactId = identity.contactId;
  }
  const conversation = await Conversation.findOneAndUpdate(
    filter,
    { $setOnInsert: setOnInsert },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return conversation;
}

function determineDirection({ fromEmail, accountEmail }) {
  if (!fromEmail || !accountEmail) return "inbound";
  return fromEmail.toLowerCase() === accountEmail.toLowerCase()
    ? "outbound"
    : "inbound";
}

/**
 * Import a single Gmail message into Conversation/Message/ContactIdentity.
 *
 * Idempotent — relies on the unique compound index on
 * `(tenantId, channelAccountId, providerMessageId)` to silently skip
 * duplicates when a history page replays.
 *
 * Returns { messageId, created, conversationId, direction } or null when
 * Gmail no longer has the message (deleted between history list and get).
 */
export async function importGmailMessage({
  tenantId,
  channelAccount,
  accessToken,
  gmailMessageId,
}) {
  if (!gmailMessageId) return null;

  const existing = await Message.findOne({
    tenantId,
    channelAccountId: channelAccount._id,
    providerMessageId: gmailMessageId,
  })
    .select("_id conversationId direction")
    .lean();
  if (existing) {
    return {
      messageId: String(existing._id),
      conversationId: String(existing.conversationId),
      direction: existing.direction,
      created: false,
    };
  }

  let detail;
  try {
    detail = await callGmail(
      `${GMAIL_BASE}/messages/${encodeURIComponent(gmailMessageId)}` +
        `?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject` +
        `&metadataHeaders=Date&metadataHeaders=Message-Id&metadataHeaders=Cc`,
      accessToken,
    );
  } catch (err) {
    if (err instanceof GmailNotFoundError) {
      logger.info(
        `[GmailSync] message ${gmailMessageId} no longer available (404); skipping`,
      );
      return null;
    }
    throw err;
  }

  const headers = detail?.payload?.headers || [];
  const fromHeader = decodeHeader(headers, "From");
  const toHeader = decodeHeader(headers, "To");
  const subject = decodeHeader(headers, "Subject");
  const dateHeader = decodeHeader(headers, "Date");
  const internalDateMs = detail.internalDate ? Number(detail.internalDate) : 0;
  const providerTimestamp =
    Number.isFinite(internalDateMs) && internalDateMs > 0
      ? new Date(internalDateMs)
      : dateHeader
        ? new Date(dateHeader)
        : new Date();

  const fromAddr = parseAddress(fromHeader);
  const accountEmail = channelAccount.providerAccountId;
  const direction = determineDirection({
    fromEmail: fromAddr?.email,
    accountEmail,
  });

  const counterpart =
    direction === "inbound"
      ? fromAddr
      : parseAddressList(toHeader)[0] || fromAddr;

  const identity = counterpart?.email
    ? await upsertContactIdentity({
        tenantId,
        email: counterpart.email,
        displayName: counterpart.name,
        observedAt: providerTimestamp,
      })
    : null;

  const conversation = await upsertConversationForThread({
    tenantId,
    channelAccount,
    threadId: detail.threadId || gmailMessageId,
    participant: counterpart,
    identity,
  });

  const labels = Array.isArray(detail.labelIds) ? detail.labelIds : [];
  const isUnread = direction === "inbound" && labels.includes("UNREAD");
  const snippet = snippetFromBody(detail.snippet, subject);
  const body = detail.snippet || "";

  let messageDoc;
  try {
    messageDoc = await Message.create({
      tenantId,
      conversationId: conversation._id,
      channelAccountId: channelAccount._id,
      channel: "gmail",
      direction,
      status: direction === "inbound" ? "sent" : "sent",
      providerMessageId: gmailMessageId,
      contentType: "text",
      body,
      subject: subject || null,
      senderName: fromAddr?.name || fromAddr?.email || null,
      senderIdentifier: fromAddr?.email || null,
      contactIdentityId: identity?._id || null,
      providerTimestamp,
      providerMeta: {
        gmail: {
          threadId: detail.threadId || null,
          messageId: gmailMessageId,
          internalDate: detail.internalDate || null,
          labelIds: labels,
          historyId: detail.historyId || null,
          messageIdHeader: decodeHeader(headers, "Message-Id"),
        },
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      const existingNow = await Message.findOne({
        tenantId,
        channelAccountId: channelAccount._id,
        providerMessageId: gmailMessageId,
      })
        .select("_id conversationId direction")
        .lean();
      if (existingNow) {
        return {
          messageId: String(existingNow._id),
          conversationId: String(existingNow.conversationId),
          direction: existingNow.direction,
          created: false,
        };
      }
    }
    throw err;
  }

  const conversationUpdate = {
    $inc: { messageCount: 1 },
    $set: {
      lastMessageAt: providerTimestamp,
      lastMessageSnippet: snippet,
      lastMessageDirection: direction,
    },
  };
  if (isUnread) conversationUpdate.$inc.unreadCount = 1;

  if (!conversation.firstMessageAt) {
    conversationUpdate.$set.firstMessageAt = providerTimestamp;
    if (direction === "inbound") {
      conversationUpdate.$set.firstUnrepliedAt = providerTimestamp;
    }
  } else if (direction === "outbound" && !conversation.firstReplyAt) {
    conversationUpdate.$set.firstReplyAt = providerTimestamp;
  }

  if (conversation.status === "closed" && direction === "inbound") {
    conversationUpdate.$set.status = "open";
  }

  await Conversation.updateOne({ _id: conversation._id, tenantId }, conversationUpdate);

  return {
    messageId: String(messageDoc._id),
    conversationId: String(conversation._id),
    direction,
    created: true,
  };
}

async function fetchHistoryPages({ accessToken, startHistoryId }) {
  const messageIds = new Set();
  let pageToken = null;
  let latestHistoryId = startHistoryId;

  do {
    const params = new URLSearchParams({
      startHistoryId: String(startHistoryId),
      maxResults: String(HISTORY_LIST_PAGE_SIZE),
      historyTypes: "messageAdded",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const page = await callGmail(
      `${GMAIL_BASE}/history?${params.toString()}`,
      accessToken,
    );

    if (page.historyId) latestHistoryId = String(page.historyId);

    for (const entry of page.history || []) {
      if (entry.id) latestHistoryId = String(entry.id);
      for (const added of entry.messagesAdded || []) {
        const id = added?.message?.id;
        if (id) messageIds.add(String(id));
      }
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return { messageIds: [...messageIds], latestHistoryId };
}

async function fetchRecentMessageIds({ accessToken, limit }) {
  const params = new URLSearchParams({
    maxResults: String(limit || BOOTSTRAP_MESSAGE_LIMIT),
  });
  const list = await callGmail(
    `${GMAIL_BASE}/messages?${params.toString()}`,
    accessToken,
  );
  return (list.messages || [])
    .map((m) => m?.id)
    .filter(Boolean)
    .map(String);
}

async function fetchProfileHistoryId(accessToken) {
  const profile = await callGmail(`${GMAIL_BASE}/profile`, accessToken);
  return profile.historyId ? String(profile.historyId) : null;
}

export async function bootstrapMailbox({
  tenantId,
  channelAccountId,
  limit = BOOTSTRAP_MESSAGE_LIMIT,
} = {}) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) {
    return { bootstrapped: false, reason: "channel-account-not-found" };
  }

  const accessToken = await getFreshAccessToken(tenantId, channelAccountId);
  const messageIds = await fetchRecentMessageIds({ accessToken, limit });
  let imported = 0;
  let scanned = 0;
  for (const id of messageIds) {
    scanned += 1;
    const result = await importGmailMessage({
      tenantId,
      channelAccount: account,
      accessToken,
      gmailMessageId: id,
    });
    if (result?.created) imported += 1;
  }

  const profileHistoryId = await fetchProfileHistoryId(accessToken);
  const cursor = profileHistoryId || account.syncCursor || null;

  await ChannelAccount.updateOne(
    { _id: account._id, tenantId },
    {
      $set: {
        ...(cursor ? { syncCursor: cursor } : {}),
        lastSyncAt: new Date(),
        consecutiveErrors: 0,
        lastError: null,
        status: "connected",
      },
    },
  );

  return {
    bootstrapped: true,
    scanned,
    imported,
    cursor,
  };
}

/**
 * Run a Gmail history-list pass for one ChannelAccount.
 *
 * Behaviour:
 *   - When `syncCursor` is missing → bootstrap.
 *   - Walk `users.history.list` from `syncCursor`, collecting unique
 *     `messagesAdded[].message.id`.
 *   - Fetch and import each new message (idempotent via Message unique index).
 *   - Advance `ChannelAccount.syncCursor` to the latest historyId observed.
 *   - On Gmail 404 (history expired) → bootstrap.
 */
export async function syncFromHistoryId({
  tenantId,
  channelAccountId,
  fallbackHistoryId = null,
} = {}) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) {
    return { synced: false, reason: "channel-account-not-found" };
  }

  const startHistoryId = account.syncCursor || fallbackHistoryId;
  if (!startHistoryId) {
    return bootstrapMailbox({ tenantId, channelAccountId });
  }

  const accessToken = await getFreshAccessToken(tenantId, channelAccountId);

  let pageResult;
  try {
    pageResult = await fetchHistoryPages({ accessToken, startHistoryId });
  } catch (err) {
    if (err instanceof GmailHistoryGoneError) {
      logger.warn(
        `[GmailSync] history expired for account ${account._id}; bootstrapping`,
      );
      return bootstrapMailbox({ tenantId, channelAccountId });
    }
    await ChannelAccount.updateOne(
      { _id: account._id, tenantId },
      {
        $inc: { consecutiveErrors: 1 },
        $set: { lastError: err?.message || "gmail history list failed" },
      },
    );
    throw err;
  }

  let imported = 0;
  for (const id of pageResult.messageIds) {
    const result = await importGmailMessage({
      tenantId,
      channelAccount: account,
      accessToken,
      gmailMessageId: id,
    });
    if (result?.created) imported += 1;
  }

  const nextCursor = pageResult.latestHistoryId || startHistoryId;

  await ChannelAccount.updateOne(
    { _id: account._id, tenantId },
    {
      $set: {
        syncCursor: nextCursor,
        lastSyncAt: new Date(),
        consecutiveErrors: 0,
        lastError: null,
        status: "connected",
      },
    },
  );

  return {
    synced: true,
    scanned: pageResult.messageIds.length,
    imported,
    cursor: nextCursor,
  };
}

export const GmailSyncService = {
  syncFromHistoryId,
  bootstrapMailbox,
  importGmailMessage,
  parseAddress,
  parseAddressList,
  extractBodies,
};

export { GmailHistoryGoneError, GmailNotFoundError };
