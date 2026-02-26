import mongoose from "mongoose";

/**
 * Invite Schema
 * Email-based user invitations for secure onboarding
 */
const inviteSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
      index: true,
    },
    role: {
      type: String,
      enum: ["admin", "marketing", "user"],
      required: [true, "Role is required"],
      default: "user",
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      // Token is hashed (SHA256) - never store plaintext
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      // Auto-expire after 7 days
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
inviteSchema.index({ tenantId: 1, email: 1 });
inviteSchema.index({ tenantId: 1, status: 1 });
inviteSchema.index({ expiresAt: 1 }); // For cleanup job
inviteSchema.index({ createdAt: -1 });

export default mongoose.model("Invite", inviteSchema);
