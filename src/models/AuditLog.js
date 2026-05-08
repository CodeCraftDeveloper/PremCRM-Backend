import mongoose from "mongoose";

/**
 * AuditLog Schema — Enterprise-level structured audit logging
 * Async write, queue-ready. Does NOT block request flow.
 */
const auditLogSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    action: {
      type: String,
      required: true,
      // Pattern: module.verb — validated via regex for extensibility
      validate: {
        validator: (v) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(v),
        message: (props) =>
          `"${props.value}" is not a valid action (expected module.verb)`,
      },
    },
    entityType: {
      type: String,
      required: true,
      enum: [
        "user",
        "lead",
        "client",
        "tenant",
        "event",
        "ticket",
        "settings",
        "system",
        "contact",
        "account",
        "deal",
        "activity",
        "pipeline",
        "blueprint",
        "automation",
        "workflow",
        "custom_module",
        "custom_field",
        "module_layout",
        "form_definition",
        "message",
        "approval_request",
        "whatsapp_template",
        "ai_run",
        "prompt_template",
        "brand_profile",
        "content_draft",
        "gmb_location",
        "review",
        "review_reply",
      ],
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    description: {
      type: String,
      maxlength: 500,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    requestId: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Indexes for fast querying
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, entityType: 1, entityId: 1 });
auditLogSchema.index({ requestId: 1 });

// TTL index — auto-delete after 365 days
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31_536_000 });

/**
 * Async fire-and-forget write. Never blocks request flow.
 */
auditLogSchema.statics.record = function (data) {
  // Use setImmediate to defer to next tick — non-blocking
  setImmediate(() => {
    this.create(data).catch((err) => {
      console.error("[AuditLog] Failed to write audit record:", err.message);
    });
  });
};

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

export default AuditLog;
