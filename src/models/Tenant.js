import mongoose from "mongoose";

/**
 * Tenant Schema
 * Multi-tenant support - each tenant is isolated
 */
const tenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Tenant name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    company: {
      name: {
        type: String,
        trim: true,
        maxlength: [200, "Company name cannot exceed 200 characters"],
      },
      logoUrl: {
        type: String,
        trim: true,
        maxlength: [500, "Company logo URL cannot exceed 500 characters"],
      },
      referenceId: {
        type: String,
        trim: true,
        maxlength: [100, "Company reference ID cannot exceed 100 characters"],
      },
    },
    plan: {
      type: String,
      enum: ["free", "pro", "enterprise"],
      default: "free",
    },
    activeUsers: {
      type: Number,
      default: 0,
    },
    allowedRoles: {
      type: [String],
      default: ["admin", "marketing", "user"],
    },
    subscription: {
      status: {
        type: String,
        enum: ["active", "paused", "cancelled"],
        default: "active",
      },
      stripeCustomerId: {
        type: String,
        select: false,
      },
      stripeSubscriptionId: {
        type: String,
        select: false,
      },
      billingCycleStart: Date,
      billingCycleEnd: Date,
    },
    settings: {
      maxUsers: {
        type: Number,
        default: 10,
      },
      maxEvents: {
        type: Number,
        default: 100,
      },
      allowEmailSync: {
        type: Boolean,
        default: true,
      },
      timezone: {
        type: String,
        default: "UTC",
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    suspendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    suspendReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, "Suspend reason cannot exceed 500 characters"],
    },
    lastActivityAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance (slug already indexed via unique: true)
tenantSchema.index({ isActive: 1, plan: 1 });
tenantSchema.index({ createdAt: -1 });

export default mongoose.model("Tenant", tenantSchema);
