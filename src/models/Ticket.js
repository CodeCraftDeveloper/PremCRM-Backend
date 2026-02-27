import mongoose from "mongoose";

// ═══════════════════════════════════════════════════════════
// TICKET STATUSES & PRIORITIES
// ═══════════════════════════════════════════════════════════

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_customer",
  "waiting_on_third_party",
  "resolved",
  "closed",
  "reopened",
];

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"];

export const TICKET_TYPES = [
  "lead_inquiry",
  "support",
  "follow_up",
  "complaint",
  "feature_request",
  "general",
];

export const TICKET_CHANNELS = [
  "web_form",
  "email",
  "phone",
  "whatsapp",
  "social_media",
  "walk_in",
  "api",
  "manual",
];

const ticketSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    // ─── Ticket Identity ───────────────────────────────────
    ticketNumber: {
      type: String,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, "Ticket title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [10000, "Description cannot exceed 10000 characters"],
    },

    // ─── Classification ────────────────────────────────────
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: "medium",
      index: true,
    },
    type: {
      type: String,
      enum: TICKET_TYPES,
      default: "general",
      index: true,
    },
    channel: {
      type: String,
      enum: TICKET_CHANNELS,
      default: "manual",
    },

    // ─── Assignment ────────────────────────────────────────
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ─── CRM Linkage (polymorphic) ────────────────────────
    relatedEntity: {
      entityType: {
        type: String,
        enum: ["lead", "contact", "account", "deal", "client", null],
        default: null,
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
    },

    // ─── Contact Info (denormalized for quick access) ──────
    contactName: {
      type: String,
      trim: true,
      maxlength: [100, "Contact name cannot exceed 100 characters"],
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
    },
    contactPhone: {
      type: String,
      trim: true,
    },
    companyName: {
      type: String,
      trim: true,
    },

    // ─── SLA & Timing ──────────────────────────────────────
    dueDate: {
      type: Date,
      default: null,
      index: true,
    },
    firstResponseAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    reopenedAt: {
      type: Date,
      default: null,
    },
    slaBreached: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ─── Follow-Up Tracking ─────────────────────────────────
    nextFollowUpDate: {
      type: Date,
      default: null,
      index: true,
    },
    lastContactedAt: {
      type: Date,
      default: null,
    },
    contactAttempts: {
      type: Number,
      default: 0,
    },

    // ─── Metadata ──────────────────────────────────────────
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    websiteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Website",
      default: null,
    },
    source: {
      type: String,
      trim: true,
    },

    // ─── File Attachments ──────────────────────────────────
    attachments: [
      {
        fileName: { type: String, required: true },
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        url: { type: String, required: true },
        s3Key: { type: String, default: null },
        uploadedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // ─── Status History (embedded for performance) ─────────
    statusHistory: [
      {
        fromStatus: { type: String },
        toStatus: { type: String, required: true },
        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        changedAt: { type: Date, default: Date.now },
        note: { type: String, trim: true },
      },
    ],

    // ─── Created By ────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ─── Soft Delete ───────────────────────────────────────
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ═══════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════

ticketSchema.index({ tenantId: 1, status: 1 });
ticketSchema.index({ tenantId: 1, priority: 1 });
ticketSchema.index({ tenantId: 1, assignedTo: 1 });
ticketSchema.index({ tenantId: 1, createdAt: -1 });
ticketSchema.index({ tenantId: 1, dueDate: 1 });
ticketSchema.index({ tenantId: 1, nextFollowUpDate: 1 });
ticketSchema.index({ tenantId: 1, slaBreached: 1 });
ticketSchema.index({
  tenantId: 1,
  "relatedEntity.entityType": 1,
  "relatedEntity.entityId": 1,
});
ticketSchema.index({
  tenantId: 1,
  title: "text",
  description: "text",
  contactName: "text",
  contactEmail: "text",
  companyName: "text",
});

// ═══════════════════════════════════════════════════════════
// AUTO-GENERATE TICKET NUMBER
// ═══════════════════════════════════════════════════════════

ticketSchema.pre("save", async function () {
  if (this.isNew && !this.ticketNumber) {
    const count = await mongoose.model("Ticket").countDocuments({
      tenantId: this.tenantId,
    });
    const paddedNum = String(count + 1).padStart(5, "0");
    this.ticketNumber = `TKT-${paddedNum}`;
  }
});

// ═══════════════════════════════════════════════════════════
// STATUS CHANGE HOOKS
// ═══════════════════════════════════════════════════════════

ticketSchema.pre("save", function () {
  if (this.isModified("status")) {
    const now = new Date();
    if (this.status === "resolved" && !this.resolvedAt) {
      this.resolvedAt = now;
    }
    if (this.status === "closed" && !this.closedAt) {
      this.closedAt = now;
    }
    if (this.status === "reopened") {
      this.reopenedAt = now;
      this.resolvedAt = null;
      this.closedAt = null;
    }
  }
});

// ═══════════════════════════════════════════════════════════
// VIRTUALS
// ═══════════════════════════════════════════════════════════

ticketSchema.virtual("remarks", {
  ref: "TicketRemark",
  localField: "_id",
  foreignField: "ticket",
});

ticketSchema.virtual("remarkCount", {
  ref: "TicketRemark",
  localField: "_id",
  foreignField: "ticket",
  count: true,
});

ticketSchema.virtual("isOverdue").get(function () {
  if (!this.dueDate) return false;
  if (["resolved", "closed"].includes(this.status)) return false;
  return new Date() > this.dueDate;
});

// ═══════════════════════════════════════════════════════════
// STATICS
// ═══════════════════════════════════════════════════════════

ticketSchema.statics.getStats = async function (tenantId, filters = {}) {
  const match = {
    tenantId: new mongoose.Types.ObjectId(tenantId),
    deletedAt: null,
  };
  if (filters.assignedTo)
    match.assignedTo = new mongoose.Types.ObjectId(filters.assignedTo);

  const [statusStats, priorityStats, overdue, slaBreached] = await Promise.all([
    this.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    this.aggregate([
      { $match: match },
      { $group: { _id: "$priority", count: { $sum: 1 } } },
    ]),
    this.countDocuments({
      ...match,
      dueDate: { $lt: new Date() },
      status: { $nin: ["resolved", "closed"] },
    }),
    this.countDocuments({
      ...match,
      slaBreached: true,
      status: { $nin: ["resolved", "closed"] },
    }),
  ]);

  const byStatus = {};
  statusStats.forEach((s) => {
    byStatus[s._id] = s.count;
  });

  const byPriority = {};
  priorityStats.forEach((p) => {
    byPriority[p._id] = p.count;
  });

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const openCount =
    (byStatus.open || 0) +
    (byStatus.in_progress || 0) +
    (byStatus.reopened || 0);
  const pendingCount =
    (byStatus.waiting_on_customer || 0) +
    (byStatus.waiting_on_third_party || 0);

  return {
    total,
    open: openCount,
    pending: pendingCount,
    resolved: byStatus.resolved || 0,
    closed: byStatus.closed || 0,
    overdue,
    slaBreached,
    byStatus,
    byPriority,
  };
};

ticketSchema.statics.getUpcomingFollowUps = function (tenantId, days = 7) {
  const now = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + days);

  return this.find({
    tenantId,
    nextFollowUpDate: { $gte: now, $lte: endDate },
    status: { $nin: ["resolved", "closed"] },
    deletedAt: null,
  })
    .populate("assignedTo", "name email")
    .sort({ nextFollowUpDate: 1 })
    .limit(50)
    .lean();
};

export default mongoose.model("Ticket", ticketSchema);
