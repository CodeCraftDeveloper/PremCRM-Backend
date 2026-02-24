import mongoose from "mongoose";

/**
 * UserSession Schema
 * Tracks user login/logout and online time for performance metrics
 */
const userSessionSchema = new mongoose.Schema(
  {
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
      // Duration in seconds
      type: Number,
      default: 0,
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
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
userSessionSchema.index({ user: 1, loginTime: -1 });
userSessionSchema.index({ user: 1, isActive: 1 });
userSessionSchema.index({ user: 1, clientSessionId: 1, isActive: 1 });
userSessionSchema.index({ createdAt: -1 });

// Middleware to calculate duration before saving
userSessionSchema.pre("save", function () {
  if (this.logoutTime && this.loginTime) {
    this.duration = Math.floor((this.logoutTime - this.loginTime) / 1000); // Convert to seconds
  }
});

export default mongoose.model("UserSession", userSessionSchema);
