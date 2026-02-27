import mongoose from "mongoose";

/**
 * CRM Activity — Tasks, Calls, Meetings, Emails.
 * Uses polymorphic reference to link to Lead, Contact, Deal, or Account.
 */
const crmActivitySchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ── Type ────────────────────────────────────────────
    type: {
      type: String,
      required: true,
      enum: ["task", "call", "meeting", "email"],
      index: true,
    },

    // ── Core ────────────────────────────────────────────
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
      maxlength: 300,
    },
    description: { type: String, maxlength: 5000 },

    // ── Status ──────────────────────────────────────────
    status: {
      type: String,
      enum: ["planned", "in_progress", "completed", "cancelled"],
      default: "planned",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    // ── Dates ───────────────────────────────────────────
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Owner ───────────────────────────────────────────
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Polymorphic Relation ────────────────────────────
    relatedTo: {
      entityType: {
        type: String,
        required: false,
        enum: ["lead", "contact", "deal", "account"],
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false,
      },
    },

    // ── Meeting-specific ────────────────────────────────
    location: { type: String, trim: true, maxlength: 300 },
    startTime: { type: Date },
    endTime: { type: Date },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // ── Call-specific ───────────────────────────────────
    callDuration: { type: Number, default: 0, min: 0 }, // minutes
    callResult: {
      type: String,
      enum: [
        "connected",
        "no_answer",
        "busy",
        "left_message",
        "wrong_number",
        null,
      ],
      default: null,
    },

    // ── Flexible ────────────────────────────────────────
    tags: [{ type: String, trim: true }],
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    customData: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    /** Flattened searchable custom field values for efficient queries */
    searchIndex: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Soft delete ─────────────────────────────────────
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
crmActivitySchema.index({ tenantId: 1, createdAt: -1 });
crmActivitySchema.index({
  tenantId: 1,
  "relatedTo.entityType": 1,
  "relatedTo.entityId": 1,
});
crmActivitySchema.index({ tenantId: 1, ownerId: 1, dueDate: 1 });
crmActivitySchema.index({ tenantId: 1, type: 1, status: 1 });
crmActivitySchema.index({ tenantId: 1, status: 1, dueDate: 1 });

export default mongoose.model("CrmActivity", crmActivitySchema);
