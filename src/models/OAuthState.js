import mongoose from "mongoose";

export const OAUTH_STATE_PROVIDERS = Object.freeze(["google"]);

const oauthStateSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: OAUTH_STATE_PROVIDERS,
      required: true,
    },
    stateHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    codeVerifierEncrypted: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      select: false,
    },
    scopes: {
      type: [String],
      default: [],
    },
    redirectAfter: {
      type: String,
      trim: true,
      maxlength: 2048,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: {
      type: Date,
      default: null,
      index: true,
    },
    requestIp: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
    },
    consumedByIp: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

oauthStateSchema.index({ tenantId: 1, provider: 1, createdAt: -1 });
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OAuthState = mongoose.model("OAuthState", oauthStateSchema);

export default OAuthState;
