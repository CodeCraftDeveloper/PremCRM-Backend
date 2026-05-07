import ChannelAccount from "../models/inbox/ChannelAccount.js";
import { ApiError } from "../utils/apiResponse.js";
import { GoogleOAuthService } from "./googleOAuthService.js";
import logger from "../utils/logger.js";

const GMAIL_WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
const GMAIL_STOP_URL = "https://gmail.googleapis.com/gmail/v1/users/me/stop";

/**
 * Default renewal threshold. Gmail watches expire after 7 days; we
 * renew anything within 24h of expiry on each scheduler tick.
 */
const DEFAULT_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function getConfiguredTopicName() {
  const value = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!value || typeof value !== "string") return null;
  return value.trim() || null;
}

function getConfiguredLabelIds() {
  const raw = process.env.GOOGLE_GMAIL_WATCH_LABEL_IDS;
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function getAccessTokenForAccount(tenantId, channelAccountId) {
  const credentials = await GoogleOAuthService.getDecryptedGoogleCredentials(
    tenantId,
    channelAccountId,
  );

  const expiresAt = credentials.expiresAt
    ? new Date(credentials.expiresAt).getTime()
    : 0;
  const expiresSoon = expiresAt && expiresAt - Date.now() < 60 * 1000;

  if (!credentials.accessToken || expiresSoon) {
    const refreshed = await GoogleOAuthService.refreshGoogleAccessToken(
      tenantId,
      channelAccountId,
    );
    return refreshed.accessToken;
  }

  return credentials.accessToken;
}

async function callGmail(method, url, accessToken, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data?.error?.message || `Gmail API ${method} ${url} failed (${response.status})`;
    throw ApiError.badRequest(message);
  }
  return data;
}

/**
 * Start (or refresh) a Gmail Pub/Sub watch for the given channel account.
 *
 * Persists the returned `historyId` and `expiration` onto
 * `ChannelAccount.providerMeta.gmailWatch` and mirrors the historyId into
 * `ChannelAccount.syncCursor` so the eventual sync worker can resume.
 */
async function startWatch(
  tenantId,
  channelAccountId,
  { topicName, labelIds, labelFilterAction = "include" } = {},
) {
  const resolvedTopic = topicName || getConfiguredTopicName();
  if (!resolvedTopic) {
    throw ApiError.badRequest(
      "Gmail Pub/Sub topic is not configured. Set GOOGLE_PUBSUB_TOPIC.",
    );
  }

  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("Gmail channel account not found");

  const accessToken = await getAccessTokenForAccount(tenantId, channelAccountId);
  const requestLabels = labelIds && labelIds.length
    ? labelIds
    : getConfiguredLabelIds();

  const body = { topicName: resolvedTopic };
  if (requestLabels.length) {
    body.labelIds = requestLabels;
    body.labelFilterAction = labelFilterAction;
  }

  const result = await callGmail("POST", GMAIL_WATCH_URL, accessToken, body);

  const expirationMs = result.expiration ? Number(result.expiration) : null;
  const expiration = Number.isFinite(expirationMs)
    ? new Date(expirationMs)
    : null;
  const historyId = result.historyId ? String(result.historyId) : null;

  const watchMeta = {
    topicName: resolvedTopic,
    labelIds: requestLabels,
    labelFilterAction: requestLabels.length ? labelFilterAction : null,
    historyId,
    expiration: expiration ? expiration.toISOString() : null,
    watchedAt: new Date().toISOString(),
  };

  await ChannelAccount.updateOne(
    { _id: account._id, tenantId, provider: "gmail" },
    {
      $set: {
        "providerMeta.gmailWatch": watchMeta,
        ...(historyId ? { syncCursor: historyId } : {}),
        consecutiveErrors: 0,
        lastError: null,
        status: "connected",
      },
    },
  );

  return { historyId, expiration, topicName: resolvedTopic, labelIds: requestLabels };
}

async function stopWatch(tenantId, channelAccountId) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: "gmail",
    deletedAt: null,
  });
  if (!account) throw ApiError.notFound("Gmail channel account not found");

  const accessToken = await getAccessTokenForAccount(tenantId, channelAccountId);
  await callGmail("POST", GMAIL_STOP_URL, accessToken);

  await ChannelAccount.updateOne(
    { _id: account._id, tenantId, provider: "gmail" },
    { $unset: { "providerMeta.gmailWatch": "" } },
  );

  return { stopped: true };
}

/**
 * Find Gmail channel accounts whose watch is missing or expiring soon.
 * Pure read; ordering is by earliest expiration so the renewal loop
 * deals with the most urgent accounts first.
 */
async function findAccountsNeedingRenewal({
  windowMs = DEFAULT_RENEWAL_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const horizon = new Date(now + windowMs).toISOString();

  return ChannelAccount.find({
    provider: "gmail",
    status: "connected",
    deletedAt: null,
    $or: [
      { "providerMeta.gmailWatch.expiration": null },
      { "providerMeta.gmailWatch.expiration": { $exists: false } },
      { "providerMeta.gmailWatch.expiration": { $lte: horizon } },
    ],
  })
    .sort({ "providerMeta.gmailWatch.expiration": 1, createdAt: 1 })
    .limit(200)
    .lean();
}

/**
 * Run the renewal pass: find accounts needing renewal and call startWatch
 * on each. Errors per account are isolated so one bad account does not
 * block the whole batch. Returns a summary for the scheduler log.
 */
async function runRenewalPass({ windowMs } = {}) {
  const accounts = await findAccountsNeedingRenewal({ windowMs });
  let renewed = 0;
  const failures = [];

  for (const account of accounts) {
    try {
      await startWatch(account.tenantId, account._id);
      renewed += 1;
    } catch (err) {
      failures.push({
        channelAccountId: String(account._id),
        tenantId: String(account.tenantId),
        error: err?.message || "unknown",
      });
      logger.error(
        `Gmail watch renewal failed for account ${account._id}: ${
          err?.message || err
        }`,
      );
    }
  }

  return { scanned: accounts.length, renewed, failures };
}

export const GmailWatchService = {
  startWatch,
  stopWatch,
  findAccountsNeedingRenewal,
  runRenewalPass,
  DEFAULT_RENEWAL_WINDOW_MS,
};
