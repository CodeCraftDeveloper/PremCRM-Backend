import mongoose from "mongoose";

/**
 * TenantSettings Schema — Per-tenant configuration layer
 * Stores lead pipeline, custom fields, SLA, assignment rules, feature flags.
 */
const tenantSettingsSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      unique: true,
    },

    // ── Lead Status Pipeline ──────────────────────────────────────────
    leadStatusPipeline: {
      type: [String],
      default: [
        "new",
        "contacted",
        "interested",
        "qualified",
        "closed",
        "lost",
      ],
    },

    // ── Custom Fields ─────────────────────────────────────────────────
    customFields: {
      lead: {
        type: [
          {
            key: { type: String, required: true },
            label: { type: String, required: true },
            type: {
              type: String,
              enum: ["text", "number", "date", "select", "boolean"],
              default: "text",
            },
            options: [String], // For select type
            required: { type: Boolean, default: false },
          },
        ],
        default: [],
      },
      client: {
        type: [
          {
            key: { type: String, required: true },
            label: { type: String, required: true },
            type: {
              type: String,
              enum: ["text", "number", "date", "select", "boolean"],
              default: "text",
            },
            options: [String],
            required: { type: Boolean, default: false },
          },
        ],
        default: [],
      },
    },

    // ── SLA Timings (in hours) ────────────────────────────────────────
    sla: {
      firstResponseTime: {
        type: Number,
        default: 24, // hours
      },
      followUpInterval: {
        type: Number,
        default: 48, // hours
      },
      maxIdleDays: {
        type: Number,
        default: 7, // days before lead is flagged stale
      },
    },

    // ── Assignment Rules ──────────────────────────────────────────────
    assignmentRules: {
      method: {
        type: String,
        enum: ["round_robin", "least_loaded", "manual"],
        default: "round_robin",
      },
      autoAssignNewLeads: {
        type: Boolean,
        default: false,
      },
      maxLeadsPerUser: {
        type: Number,
        default: 50,
      },
    },

    // ── Feature Flags ─────────────────────────────────────────────────
    features: {
      advancedAnalytics: {
        type: Boolean,
        default: false,
      },
      workflows: {
        type: Boolean,
        default: false,
      },
      exports: {
        type: Boolean,
        default: true,
      },
      leadScoring: {
        type: Boolean,
        default: false,
      },
      duplicateDetection: {
        type: Boolean,
        default: true,
      },
      customFields: {
        type: Boolean,
        default: false,
      },
      apiAccess: {
        type: Boolean,
        default: true,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Index for fast lookup
tenantSettingsSchema.index({ tenantId: 1 }, { unique: true });

/**
 * Get or create settings for a tenant (lazy initialization).
 */
tenantSettingsSchema.statics.getForTenant = async function (tenantId) {
  let settings = await this.findOne({ tenantId }).lean();
  if (!settings) {
    settings = await this.create({ tenantId });
    settings = settings.toObject();
  }
  return settings;
};

const TenantSettings = mongoose.model("TenantSettings", tenantSettingsSchema);

export default TenantSettings;
