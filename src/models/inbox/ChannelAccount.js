import mongoose from "mongoose";

/**
 * ChannelAccount — a connected provider account for a tenant.
 *
 * Each record represents one OAuth grant or API credential set for a
 * specific provider (Gmail, WhatsApp Cloud API, Meta Pages, GMB).
 * A tenant may connect multiple accounts of the same provider
 * (e.g. two Gmail mailboxes or several Facebook Pages).
 *
 * Credentials are stored encrypted.  The `credentials` field holds the
 * encrypted blob produced by the token-vault service (P5-001).  This
 * model never stores plaintext tokens.
 *
 * Lifecycle:
 *   connected  → active state, sync running
 *   disconnected → user revoked; credentials cleared, sync paused
 *   error       → refresh failed or provider revoked; needs reconnect
 *   suspended   → admin/plan action; credentials kept, sync paused
 */

// ── Constants ────────────────────────────────────────────
export const CHANNEL_PROVIDERS = Object.freeze([
  "gmail",
  "whatsapp",
  "meta",
  "gmb",
]);

export const CHANNEL_ACCOUNT_STATUSES = Object.freeze([
  "connected",
  "disconnected",
  "error",
  "suspended",
]);

// ── Schema ───────────────────────────────────────────────
const channelAccountSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    /** Which integration provider. */
    provider: {
      type: String,
      required: [true, "Provider is required"],
      enum: CHANNEL_PROVIDERS,
    },

    /**
     * Provider-side unique identifier.
     *   Gmail  → email address
     *   WhatsApp → phone number ID
     *   Meta   → page ID
     *   GMB    → location ID
     */
    providerAccountId: {
      type: String,
      required: [true, "Provider account ID is required"],
      trim: true,
      maxlength: 256,
    },

    /** Human-readable label (e.g. "sales@acme.com", "Main FB Page"). */
    displayName: {
      type: String,
      trim: true,
      maxlength: 200,
    },

    /** Connection lifecycle status. */
    status: {
      type: String,
      enum: CHANNEL_ACCOUNT_STATUSES,
      default: "connected",
    },

    /**
     * Encrypted credential blob.  Shape depends on provider:
     *   Gmail    → { accessToken, refreshToken, expiresAt, scopes }
     *   WhatsApp → { accessToken, businessAccountId }
     *   Meta     → { pageAccessToken, expiresAt }
     *   GMB      → { accessToken, refreshToken, expiresAt }
     *
     * Written and read exclusively by the token-vault service.
     * Selected `false` so casual queries never load tokens.
     */
    credentials: {
      type: mongoose.Schema.Types.Mixed,
      select: false,
      default: null,
    },

    /**
     * OAuth scopes granted.  Useful for checking whether re-consent is
     * needed when the app adds new scopes.
     */
    scopes: {
      type: [String],
      default: [],
    },

    // ── Sync state ───────────────────────────────────────

    /** Provider-specific sync cursor (e.g. Gmail historyId, WA cursor). */
    syncCursor: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },

    /** When the last successful sync completed. */
    lastSyncAt: {
      type: Date,
      default: null,
    },

    /** Number of consecutive sync failures.  Reset on success. */
    consecutiveErrors: {
      type: Number,
      default: 0,
      min: 0,
    },

    /** Last error message for ops triage. */
    lastError: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    /** Provider-specific metadata (e.g. webhook subscription ID). */
    providerMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // ── Ownership ────────────────────────────────────────

    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Soft delete ──────────────────────────────────────

    deletedAt: { type: Date, default: null, index: true },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
// Primary lookup: which accounts does this tenant have?
channelAccountSchema.index({ tenantId: 1, provider: 1, status: 1 });

// Unique constraint: one connection per provider account per tenant.
// Prevents accidentally linking the same Gmail/WhatsApp twice.
channelAccountSchema.index(
  { tenantId: 1, provider: 1, providerAccountId: 1 },
  { unique: true, name: "channel_account_provider_uniq" },
);

// Reverse lookup: find tenant from provider webhook data.
channelAccountSchema.index({ provider: 1, providerAccountId: 1 });

channelAccountSchema.index({ tenantId: 1, createdAt: -1 });

const ChannelAccount = mongoose.model("ChannelAccount", channelAccountSchema);

export default ChannelAccount;
