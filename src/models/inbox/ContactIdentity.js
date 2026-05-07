import mongoose from "mongoose";

/**
 * ContactIdentity — maps a provider-side identifier to a CRM Contact.
 *
 * When a message arrives from an external channel, the inbox service
 * looks up the sender's provider identifier (email, phone number,
 * social user ID, etc.) in this collection to find or create the
 * associated CRM Contact.
 *
 * One Contact may have multiple identities (work email + personal
 * email + WhatsApp number).  One identity belongs to exactly one
 * Contact within a tenant.
 *
 * This collection bridges the gap between "an email address sent us a
 * message" and "this is Alice from Acme Corp in our CRM".
 */

// ── Constants ────────────────────────────────────────────
export const IDENTITY_PROVIDERS = Object.freeze([
  "email",     // Any email address (could be Gmail, Outlook, etc.)
  "whatsapp",  // WhatsApp phone number
  "meta",      // Facebook/Instagram user ID
  "gmb",       // GMB reviewer ID (anonymised, provider-assigned)
  "phone",     // Generic phone/SMS
]);

// ── Schema ───────────────────────────────────────────────
const contactIdentitySchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    /**
     * The CRM Contact this identity is linked to.
     * Null when the identity has not yet been resolved to a Contact
     * (e.g. inbound message from an unknown sender; a ghost Contact
     * can be created lazily or left unlinked until the user merges).
     */
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },

    /** Identity namespace / channel type. */
    provider: {
      type: String,
      required: [true, "Provider is required"],
      enum: IDENTITY_PROVIDERS,
    },

    /**
     * The canonical identifier within the provider namespace.
     *   email    → lowercase email address
     *   whatsapp → E.164 phone number
     *   meta     → PSID or IGSID
     *   gmb      → reviewer ID
     *   phone    → E.164 phone number
     */
    providerIdentifier: {
      type: String,
      required: [true, "Provider identifier is required"],
      trim: true,
      maxlength: 320,  // max RFC-5321 email path length
    },

    /** Human-readable label discovered from provider (e.g. display name). */
    displayName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    /** Profile avatar URL from the provider. */
    avatarUrl: {
      type: String,
      trim: true,
      maxlength: 1024,
      default: null,
    },

    /** Whether this identity has been verified (opt-in confirmation, etc.). */
    verified: {
      type: Boolean,
      default: false,
    },

    /** Extra provider metadata (e.g. WhatsApp profile name, FB locale). */
    providerMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    /** When this identity was last seen (most recent message or interaction). */
    lastSeenAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
// Unique: one identity per provider+identifier per tenant.
contactIdentitySchema.index(
  { tenantId: 1, provider: 1, providerIdentifier: 1 },
  { unique: true, name: "identity_provider_uniq" },
);

// Fast lookup: all identities for a CRM Contact.
contactIdentitySchema.index({ tenantId: 1, contactId: 1 });

// Reverse lookup: given a provider identifier, find the tenant + contact.
contactIdentitySchema.index({ provider: 1, providerIdentifier: 1 });

contactIdentitySchema.index({ tenantId: 1, createdAt: -1 });

// ── Pre-save: normalise identifiers ──────────────────────
contactIdentitySchema.pre("save", function normaliseIdentifier() {
  if (this.isModified("providerIdentifier")) {
    if (this.provider === "email") {
      this.providerIdentifier = this.providerIdentifier.toLowerCase();
    }
  }
});

const ContactIdentity = mongoose.model(
  "ContactIdentity",
  contactIdentitySchema,
);

export default ContactIdentity;
