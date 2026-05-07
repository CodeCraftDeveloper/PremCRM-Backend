/**
 * Tests for P5-001 Google OAuth Token Vault:
 *   1. TokenVaultService encrypts provider credentials without plaintext leaks.
 *   2. OAuth state uses a hashed state, encrypted PKCE verifier, TTL, and one-time use.
 *   3. Google OAuth callback exchanges the code, validates state ownership, and stores
 *      encrypted Gmail credentials in ChannelAccount.
 *   4. Refresh flow decrypts the refresh token and re-encrypts the updated access token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URI =
  "http://localhost:5000/api/v1/integrations/google/oauth/callback";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

let mongoServer;
let Tenant;
let User;
let ChannelAccount;
let OAuthState;
let TokenVaultService;
let GoogleOAuthService;

const oid = () => new mongoose.Types.ObjectId();

function jsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

async function createTenantCtx(slug = "google-oauth") {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "growth",
  });
  const user = await User.create({
    name: `Admin ${slug}`,
    email: `${slug}@example.com`,
    password: "Password123!",
    role: "admin",
    tenantId: tenant._id,
    isActive: true,
    approvalStatus: "approved",
  });
  return { tenant, user };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  ChannelAccount = (await import("../../src/models/inbox/ChannelAccount.js")).default;
  OAuthState = (await import("../../src/models/OAuthState.js")).default;
  TokenVaultService = (await import("../../src/services/tokenVaultService.js"))
    .TokenVaultService;
  GoogleOAuthService = (await import("../../src/services/googleOAuthService.js"))
    .GoogleOAuthService;

  await ChannelAccount.syncIndexes();
  await OAuthState.syncIndexes();
}, 30000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  vi.restoreAllMocks();
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("TokenVaultService", () => {
  it("encrypts and decrypts JSON credentials without storing plaintext", () => {
    const tenantId = oid();
    const encrypted = TokenVaultService.encryptJson(
      "gmail",
      { accessToken: "access-secret", refreshToken: "refresh-secret" },
      { tenantId },
    );

    const raw = JSON.stringify(encrypted);
    expect(raw).not.toContain("access-secret");
    expect(raw).not.toContain("refresh-secret");

    const decrypted = TokenVaultService.decryptJson("gmail", encrypted, {
      tenantId,
    });
    expect(decrypted).toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    });
  });

  it("binds encrypted credentials to provider and tenant context", () => {
    const tenantA = oid();
    const tenantB = oid();
    const encrypted = TokenVaultService.encryptJson(
      "gmail",
      { refreshToken: "tenant-bound" },
      { tenantId: tenantA },
    );

    expect(() =>
      TokenVaultService.decryptJson("gmail", encrypted, { tenantId: tenantB }),
    ).toThrow(/Unable to decrypt/);
  });
});

describe("GoogleOAuthService state and vault flow", () => {
  it("creates a Google consent URL and stores only hashed state plus encrypted verifier", async () => {
    const { tenant, user } = await createTenantCtx("state-create");
    const result = await GoogleOAuthService.beginGoogleOAuth(
      tenant._id,
      user._id,
      { redirectAfter: "/admin/inbox" },
    );

    const authUrl = new URL(result.authUrl);
    const state = authUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toContain("gmail.readonly");
    expect(authUrl.searchParams.get("scope")).toContain("gmail.send");

    const stored = await OAuthState.findOne({ tenantId: tenant._id }).select(
      "+codeVerifierEncrypted",
    );
    expect(stored.stateHash).toBe(TokenVaultService.hashSecret(state));
    expect(stored.stateHash).not.toBe(state);
    expect(JSON.stringify(stored.codeVerifierEncrypted)).not.toContain(
      "codeVerifier",
    );

    const defaultRead = await OAuthState.findById(stored._id);
    expect(defaultRead.codeVerifierEncrypted).toBeUndefined();
  });

  it("exchanges a valid code and stores encrypted Gmail credentials", async () => {
    const { tenant, user } = await createTenantCtx("callback-success");
    const start = await GoogleOAuthService.beginGoogleOAuth(
      tenant._id,
      user._id,
    );
    const state = new URL(start.authUrl).searchParams.get("state");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options = {}) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          expect(options.body).toContain("grant_type=authorization_code");
          expect(options.body).toContain("code_verifier=");
          return jsonResponse({
            access_token: "google-access-token",
            refresh_token: "google-refresh-token",
            expires_in: 3600,
            scope:
              "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            token_type: "Bearer",
          });
        }
        if (String(url).includes("openidconnect.googleapis.com")) {
          return jsonResponse({
            sub: "google-sub-123",
            email: "Sales@Example.COM",
            email_verified: true,
            name: "Sales Inbox",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

    const result = await GoogleOAuthService.exchangeGoogleOAuthCode(
      tenant._id,
      user._id,
      { state, code: "auth-code" },
    );

    expect(result.account.provider).toBe("gmail");
    expect(result.account.providerAccountId).toBe("sales@example.com");
    expect(result.account.credentials).toBeUndefined();

    const stored = await ChannelAccount.findById(result.account._id).select(
      "+credentials",
    );
    expect(JSON.stringify(stored.credentials)).not.toContain(
      "google-refresh-token",
    );

    const decrypted = await GoogleOAuthService.getDecryptedGoogleCredentials(
      tenant._id,
      result.account._id,
    );
    expect(decrypted.accessToken).toBe("google-access-token");
    expect(decrypted.refreshToken).toBe("google-refresh-token");
    expect(decrypted.googleAccount.email).toBe("sales@example.com");

    const consumed = await OAuthState.findOne({
      stateHash: TokenVaultService.hashSecret(state),
    });
    expect(consumed.consumedAt).toBeTruthy();
  });

  it("rejects OAuth state reuse and tenant mismatches", async () => {
    const ctxA = await createTenantCtx("state-a");
    const ctxB = await createTenantCtx("state-b");
    const start = await GoogleOAuthService.beginGoogleOAuth(
      ctxA.tenant._id,
      ctxA.user._id,
    );
    const state = new URL(start.authUrl).searchParams.get("state");

    await expect(
      GoogleOAuthService.exchangeGoogleOAuthCode(
        ctxB.tenant._id,
        ctxB.user._id,
        { state, code: "auth-code" },
      ),
    ).rejects.toThrow(/tenant mismatch/i);

    await OAuthState.updateOne(
      { stateHash: TokenVaultService.hashSecret(state) },
      { $set: { consumedAt: new Date() } },
    );

    await expect(
      GoogleOAuthService.exchangeGoogleOAuthCode(
        ctxA.tenant._id,
        ctxA.user._id,
        { state, code: "auth-code" },
      ),
    ).rejects.toThrow(/already used/i);
  });

  it("refreshes an access token using the encrypted refresh token", async () => {
    const { tenant, user } = await createTenantCtx("refresh-token");
    const account = await ChannelAccount.create({
      tenantId: tenant._id,
      provider: "gmail",
      providerAccountId: "refresh@example.com",
      displayName: "Refresh Gmail",
      connectedBy: user._id,
      scopes: ["openid", "email"],
      credentials: TokenVaultService.encryptJson(
        "gmail",
        {
          accessToken: "old-access",
          refreshToken: "stored-refresh",
          expiresAt: new Date().toISOString(),
          scopes: ["openid", "email"],
        },
        { tenantId: tenant._id },
      ),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options = {}) => {
        expect(String(url)).toContain("oauth2.googleapis.com/token");
        expect(options.body).toContain("grant_type=refresh_token");
        expect(options.body).toContain("refresh_token=stored-refresh");
        return jsonResponse({
          access_token: "new-access",
          expires_in: 1800,
          scope: "openid email",
          token_type: "Bearer",
        });
      }),
    );

    const refreshed = await GoogleOAuthService.refreshGoogleAccessToken(
      tenant._id,
      account._id,
    );
    expect(refreshed.accessToken).toBe("new-access");

    const decrypted = await GoogleOAuthService.getDecryptedGoogleCredentials(
      tenant._id,
      account._id,
    );
    expect(decrypted.accessToken).toBe("new-access");
    expect(decrypted.refreshToken).toBe("stored-refresh");
  });
});
