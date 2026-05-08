import mongoose from "mongoose";

/**
 * GmbLocation - tenant-scoped Google Business Profile location.
 *
 * This is the Phase 8 foundation record for locations synced from Google
 * Business Profile. It stores provider IDs, display metadata, sync state,
 * and operational status only; OAuth/token data remains on ChannelAccount.
 */

export const GMB_LOCATION_STATUSES = Object.freeze([
  "active",
  "pending",
  "suspended",
  "disabled",
  "disconnected",
]);

export const GMB_LOCATION_VERIFICATION_STATUSES = Object.freeze([
  "verified",
  "unverified",
  "pending",
  "unknown",
]);

const addressSchema = new mongoose.Schema(
  {
    addressLines: {
      type: [{ type: String, trim: true, maxlength: 256 }],
      default: [],
    },
    locality: { type: String, trim: true, maxlength: 128, default: null },
    administrativeArea: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
    },
    postalCode: { type: String, trim: true, maxlength: 32, default: null },
    regionCode: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      default: null,
    },
    languageCode: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 8,
      default: null,
    },
  },
  { _id: false },
);

const latLngSchema = new mongoose.Schema(
  {
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
  },
  { _id: false },
);

const gmbLocationSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    channelAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChannelAccount",
      required: true,
      index: true,
    },

    providerLocationId: {
      type: String,
      required: [true, "GMB provider location id is required"],
      trim: true,
      maxlength: 256,
    },

    providerAccountId: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },

    title: {
      type: String,
      required: [true, "GMB location title is required"],
      trim: true,
      maxlength: 256,
    },

    storeCode: { type: String, trim: true, maxlength: 128, default: null },
    primaryPhone: { type: String, trim: true, maxlength: 64, default: null },
    websiteUri: { type: String, trim: true, maxlength: 1024, default: null },

    address: { type: addressSchema, default: () => ({}) },
    latLng: { type: latLngSchema, default: () => ({}) },

    categories: {
      type: [{ type: String, trim: true, maxlength: 256 }],
      default: [],
    },

    verificationStatus: {
      type: String,
      enum: GMB_LOCATION_VERIFICATION_STATUSES,
      default: "unknown",
    },

    status: {
      type: String,
      enum: GMB_LOCATION_STATUSES,
      default: "active",
      index: true,
    },

    syncCursor: { type: String, trim: true, maxlength: 512, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastReviewSyncedAt: { type: Date, default: null },
    consecutiveErrors: { type: Number, min: 0, default: 0 },
    lastError: { type: String, trim: true, maxlength: 2000, default: null },

    providerMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    deletedAt: { type: Date, default: null, index: true },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

gmbLocationSchema.index({ tenantId: 1, status: 1, title: 1 });
gmbLocationSchema.index({ tenantId: 1, channelAccountId: 1, title: 1 });
gmbLocationSchema.index(
  { tenantId: 1, providerLocationId: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    name: "gmb_location_provider_uniq",
  },
);
gmbLocationSchema.index({ channelAccountId: 1, providerLocationId: 1 });

const GmbLocation = mongoose.model("GmbLocation", gmbLocationSchema);

export default GmbLocation;
