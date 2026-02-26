import mongoose from "mongoose";

/**
 * UserSession Schema
 * Tracks user login/logout and online time for performance metrics
 */
const userSessionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    loginTime: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    logoutTime: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    duration: {
      // Duration in seconds (calculated at service layer, not in pre-save hook!)
      type: Number,
      default: 0,
      index: true,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
    clientSessionId: {
      type: String,
      default: null,
    },
    device: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
userSessionSchema.index({ tenantId: 1, user: 1, loginTime: -1 });
userSessionSchema.index({ tenantId: 1, user: 1, isActive: 1 });
userSessionSchema.index({
  tenantId: 1,
  user: 1,
  clientSessionId: 1,
  isActive: 1,
});
userSessionSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("UserSession", userSessionSchema);
