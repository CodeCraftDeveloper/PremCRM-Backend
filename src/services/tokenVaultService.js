import crypto from "crypto";
import { ApiError } from "../utils/apiResponse.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function decodeConfiguredKey(value) {
  if (!value) return null;

  const trimmed = value.trim();
  const candidates = [
    Buffer.from(trimmed, "base64"),
    Buffer.from(trimmed, "hex"),
    Buffer.from(trimmed),
  ];

  return candidates.find((candidate) => candidate.length === KEY_BYTES) || null;
}

function getEncryptionKey() {
  const configured = decodeConfiguredKey(process.env.OAUTH_TOKEN_ENCRYPTION_KEY);
  if (configured) return configured;

  if (process.env.NODE_ENV === "test") {
    return crypto
      .createHash("sha256")
      .update("orbinest-test-oauth-token-vault-key")
      .digest();
  }

  throw ApiError.internal(
    "OAuth token encryption key is not configured. Set OAUTH_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or hex value.",
  );
}

function buildAad(provider, tenantId) {
  return Buffer.from(`orbinest:v1:${provider}:${tenantId || ""}`, "utf8");
}

function encryptJson(provider, payload, { tenantId } = {}) {
  if (!provider) throw ApiError.badRequest("Provider is required");
  if (payload === undefined || payload === null) {
    throw ApiError.badRequest("Credential payload is required");
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  cipher.setAAD(buildAad(provider, tenantId));

  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptJson(provider, encryptedBlob, { tenantId } = {}) {
  if (!encryptedBlob || encryptedBlob.v !== 1 || encryptedBlob.alg !== ALGORITHM) {
    throw ApiError.badRequest("Unsupported encrypted credential blob");
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getEncryptionKey(),
      Buffer.from(encryptedBlob.iv, "base64"),
    );
    decipher.setAAD(buildAad(provider, tenantId));
    decipher.setAuthTag(Buffer.from(encryptedBlob.tag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedBlob.ciphertext, "base64")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  } catch (error) {
    throw ApiError.forbidden("Unable to decrypt provider credentials");
  }
}

function hashSecret(value) {
  if (!value) throw ApiError.badRequest("Value to hash is required");
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export const TokenVaultService = {
  encryptJson,
  decryptJson,
  hashSecret,
  randomBase64Url,
  sha256Base64Url,
};
