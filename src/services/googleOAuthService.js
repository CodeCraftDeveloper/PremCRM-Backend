import { URL, URLSearchParams } from "url";
import ChannelAccount from "../models/inbox/ChannelAccount.js";
import OAuthState from "../models/OAuthState.js";
import Tenant from "../models/Tenant.js";
import { ApiError } from "../utils/apiResponse.js";
import { TokenVaultService } from "./tokenVaultService.js";
import { planHasFeature, upgradeMessage } from "./planService.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_GMAIL_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
]);

const DEFAULT_GMB_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/business.manage",
]);

function getConfiguredScopes(provider = "gmail") {
  if (provider === "gmb") {
    return (process.env.GOOGLE_GMB_OAUTH_SCOPES || "")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
      .length
      ? (process.env.GOOGLE_GMB_OAUTH_SCOPES || "")
          .split(/[,\s]+/)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [...DEFAULT_GMB_SCOPES];
  }

  return (process.env.GOOGLE_GMAIL_OAUTH_SCOPES || "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .length
    ? (process.env.GOOGLE_GMAIL_OAUTH_SCOPES || "")
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [...DEFAULT_GMAIL_SCOPES];
}

function getGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    (process.env.API_PUBLIC_URL
      ? `${process.env.API_PUBLIC_URL.replace(/\/+$/, "")}/api/v1/integrations/google/oauth/callback`
      : null);

  if (!clientId || !clientSecret || !redirectUri) {
    throw ApiError.internal(
      "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function sanitizeRedirectAfter(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed;
}

function buildFrontendRedirect(path, params) {
  const frontendBase = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (!frontendBase || !path) return null;
  const url = new URL(path, frontendBase);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function beginGoogleOAuth(
  tenantId,
  userId,
  { redirectAfter, requestIp, provider = "gmail" } = {},
) {
  const config = getGoogleOAuthConfig();
  const scopes = getConfiguredScopes(provider);
  const state = TokenVaultService.randomBase64Url(32);
  const codeVerifier = TokenVaultService.randomBase64Url(64);
  const codeChallenge = TokenVaultService.sha256Base64Url(codeVerifier);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

  await OAuthState.create({
    tenantId,
    userId,
    provider: "google",
    targetProvider: provider,
    stateHash: TokenVaultService.hashSecret(state),
    codeVerifierEncrypted: TokenVaultService.encryptJson(
      "google_oauth_state",
      { codeVerifier },
      { tenantId },
    ),
    scopes,
    redirectAfter: sanitizeRedirectAfter(redirectAfter),
    expiresAt,
    requestIp,
  });

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return {
    authUrl: authUrl.toString(),
    expiresAt,
    scopes,
  };
}

async function postGoogleToken(params) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw ApiError.badRequest(
      body.error_description || body.error || "Google OAuth token exchange failed",
    );
  }
  return body;
}

async function getGoogleUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw ApiError.badRequest("Unable to read Google account profile");
  }
  return body;
}

function normalizeGrantedScopes(tokenData, fallbackScopes) {
  return (tokenData.scope || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .length
    ? tokenData.scope
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    : fallbackScopes;
}

async function exchangeGoogleOAuthCode(
  tenantId,
  userId,
  { state, code, requestIp } = {},
) {
  if (!state) throw ApiError.badRequest("OAuth state is required");
  if (!code) throw ApiError.badRequest("OAuth authorization code is required");

  const config = getGoogleOAuthConfig();
  const stateHash = TokenVaultService.hashSecret(state);
  const oauthState = await OAuthState.findOne({
    provider: "google",
    stateHash,
  }).select("+codeVerifierEncrypted");

  if (!oauthState) throw ApiError.badRequest("Invalid OAuth state");
  if (oauthState.consumedAt) throw ApiError.badRequest("OAuth state was already used");
  if (oauthState.expiresAt <= new Date()) throw ApiError.badRequest("OAuth state expired");
  if (String(oauthState.tenantId) !== String(tenantId)) {
    throw ApiError.forbidden("OAuth state tenant mismatch");
  }
  if (String(oauthState.userId) !== String(userId)) {
    throw ApiError.forbidden("OAuth state user mismatch");
  }

  const targetProvider = oauthState.targetProvider || "gmail";

  // Check plan feature
  const tenant = await Tenant.findById(tenantId).select("plan").lean();
  const plan = tenant?.plan || "starter";
  const requiredFeature = targetProvider === "gmb" ? "gmbIntegration" : "gmailIntegration";
  if (!planHasFeature(plan, requiredFeature)) {
    throw ApiError.forbidden(upgradeMessage(requiredFeature));
  }

  const { codeVerifier } = TokenVaultService.decryptJson(
    "google_oauth_state",
    oauthState.codeVerifierEncrypted,
    { tenantId },
  );

  const tokenData = await postGoogleToken({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  if (!tokenData.access_token) {
    throw ApiError.badRequest("Google did not return an access token");
  }

  const profile = await getGoogleUserInfo(tokenData.access_token);
  const email = String(profile.email || "").trim().toLowerCase();
  if (!email) throw ApiError.badRequest("Google account email is missing");

  const existing = await ChannelAccount.findOne({
    tenantId,
    provider: targetProvider,
    providerAccountId: email,
    deletedAt: null,
  })
    .select("+credentials")
    .lean();

  const previousCredentials = existing?.credentials
    ? TokenVaultService.decryptJson(targetProvider, existing.credentials, { tenantId })
    : {};
  const refreshToken = tokenData.refresh_token || previousCredentials.refreshToken;

  if (!refreshToken) {
    throw ApiError.badRequest(
      "Google did not return a refresh token. Reconnect with offline access consent.",
    );
  }

  const scopes = normalizeGrantedScopes(tokenData, oauthState.scopes);
  const tokenPayload = {
    accessToken: tokenData.access_token,
    refreshToken,
    expiresAt: tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null,
    scopes,
    tokenType: tokenData.token_type || "Bearer",
    googleAccount: {
      sub: profile.sub || null,
      email,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name || null,
      picture: profile.picture || null,
    },
    acquiredAt: new Date().toISOString(),
  };

  const account = await ChannelAccount.findOneAndUpdate(
    { tenantId, provider: targetProvider, providerAccountId: email },
    {
      $set: {
        tenantId,
        provider: targetProvider,
        providerAccountId: email,
        displayName: profile.name || email,
        status: "connected",
        credentials: TokenVaultService.encryptJson(targetProvider, tokenPayload, {
          tenantId,
        }),
        scopes,
        connectedBy: userId,
        deletedAt: null,
        deletedBy: null,
        consecutiveErrors: 0,
        lastError: null,
        providerMeta: {
          googleSub: profile.sub || null,
          emailVerified: Boolean(profile.email_verified),
          tokenType: tokenPayload.tokenType,
          connectedAt: tokenPayload.acquiredAt,
        },
      },
    },
    { returnDocument: "after", upsert: true, runValidators: true },
  ).lean();

  await OAuthState.updateOne(
    { _id: oauthState._id, consumedAt: null },
    { $set: { consumedAt: new Date(), consumedByIp: requestIp || null } },
  );

  return {
    account,
    redirectUrl: buildFrontendRedirect(oauthState.redirectAfter, {
      [targetProvider === "gmb" ? "gmbConnected" : "gmailConnected"]: "1",
      accountId: account._id,
    }),
  };
}

async function getDecryptedGoogleCredentials(tenantId, channelAccountId) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: { $in: ["gmail", "gmb"] },
    deletedAt: null,
  }).select("+credentials");

  if (!account) throw ApiError.notFound("Google channel account not found");
  if (!account.credentials) throw ApiError.badRequest("Google account has no credentials");

  return TokenVaultService.decryptJson(account.provider, account.credentials, {
    tenantId,
  });
}

async function refreshGoogleAccessToken(tenantId, channelAccountId) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: { $in: ["gmail", "gmb"] },
    deletedAt: null,
  }).select("+credentials");

  if (!account) throw ApiError.notFound("Google channel account not found");
  if (!account.credentials) throw ApiError.badRequest("Google account has no credentials");

  const credentials = TokenVaultService.decryptJson(account.provider, account.credentials, {
    tenantId,
  });

  if (!credentials.refreshToken) {
    throw ApiError.badRequest(`${account.provider === "gmb" ? "GMB" : "Gmail"} account has no refresh token`);
  }

  const config = getGoogleOAuthConfig();
  const tokenData = await postGoogleToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });

  const nextCredentials = {
    ...credentials,
    accessToken: tokenData.access_token,
    expiresAt: tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : credentials.expiresAt,
    scopes: normalizeGrantedScopes(tokenData, credentials.scopes || []),
    tokenType: tokenData.token_type || credentials.tokenType || "Bearer",
    refreshedAt: new Date().toISOString(),
  };

  await ChannelAccount.updateOne(
    { _id: channelAccountId, tenantId, provider: account.provider },
    {
      $set: {
        credentials: TokenVaultService.encryptJson(account.provider, nextCredentials, {
          tenantId,
        }),
        scopes: nextCredentials.scopes,
        status: "connected",
        consecutiveErrors: 0,
        lastError: null,
      },
    },
  );

  return {
    accessToken: nextCredentials.accessToken,
    expiresAt: nextCredentials.expiresAt,
    scopes: nextCredentials.scopes,
  };
}

async function getFreshAccessToken(tenantId, channelAccountId) {
  const account = await ChannelAccount.findOne({
    _id: channelAccountId,
    tenantId,
    provider: { $in: ["gmail", "gmb"] },
    deletedAt: null,
  }).select("+credentials");

  if (!account) throw ApiError.notFound("Google channel account not found");
  if (!account.credentials) throw ApiError.badRequest("Google account has no credentials");

  const credentials = TokenVaultService.decryptJson(account.provider, account.credentials, {
    tenantId,
  });

  const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : null;
  if (credentials.accessToken && expiresAt && expiresAt.getTime() > Date.now() + 60000) {
    return credentials.accessToken;
  }

  const refreshResult = await refreshGoogleAccessToken(tenantId, channelAccountId);
  return refreshResult.accessToken;
}

export const GoogleOAuthService = {
  DEFAULT_GMAIL_SCOPES,
  DEFAULT_GMB_SCOPES,
  beginGoogleOAuth,
  exchangeGoogleOAuthCode,
  getDecryptedGoogleCredentials,
  refreshGoogleAccessToken,
  getFreshAccessToken,
};
