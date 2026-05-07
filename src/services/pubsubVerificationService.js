import crypto from "crypto";

/**
 * Pub/Sub push verification.
 *
 * Google Cloud Pub/Sub push subscriptions can carry two layers of
 * verification:
 *
 *   1. **Shared verification token** — a random string included in the
 *      push URL when the subscription is created (`?token=...`). Google
 *      sends this back unchanged on every push. We compare it against
 *      `GOOGLE_PUBSUB_VERIFICATION_TOKEN` in constant time. This is the
 *      minimum bar for accepting a request.
 *
 *   2. **OIDC bearer JWT** (recommended in production) — when the
 *      subscription is configured with an `oidcToken` audience, Google
 *      attaches `Authorization: Bearer <jwt>`. Full validation requires
 *      Google's public keys; for now we accept its presence as evidence
 *      and record it on the IntegrationEvent for later upgrade.
 *
 * Both checks are advisory in environments where the token is not
 * configured (development) — the verifier returns `verified=false` and
 * the controller decides whether to refuse.
 */

const TOKEN_QUERY_KEY = "token";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getConfiguredToken() {
  const value = process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function extractBearerJwt(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value.length ? value : null;
}

/**
 * Verify an inbound Pub/Sub push request.
 *
 * @param {import("express").Request} req
 * @returns {{verified: boolean, reason: string|null, hasBearer: boolean}}
 */
export function verifyPubsubPush(req) {
  const expected = getConfiguredToken();
  const provided = req.query?.[TOKEN_QUERY_KEY];
  const hasBearer = Boolean(extractBearerJwt(req));

  if (!expected) {
    return {
      verified: false,
      reason: "verification-token-not-configured",
      hasBearer,
    };
  }

  if (!provided) {
    return { verified: false, reason: "missing-token", hasBearer };
  }

  if (!safeEqual(String(provided), expected)) {
    return { verified: false, reason: "token-mismatch", hasBearer };
  }

  return { verified: true, reason: null, hasBearer };
}

export const PubsubVerification = {
  verifyPubsubPush,
  TOKEN_QUERY_KEY,
};
