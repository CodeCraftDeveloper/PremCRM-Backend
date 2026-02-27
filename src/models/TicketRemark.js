import mongoose from "mongoose";

const ticketRemarkSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    ticket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ticket",
      required: [true, "Ticket is required"],
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User is required"],
    },
    content: {
      type: String,
      required: [true, "Remark content is required"],
      trim: true,
      maxlength: [5000, "Remark cannot exceed 5000 characters"],
    },
    type: {
      type: String,
      enum: [
        "note",
        "call",
        "email",
        "meeting",
        "follow_up",
        "status_change",
        "assignment_change",
        "escalation",
        "resolution",
        "system",
      ],
      default: "note",
    },

    // For status change tracking
    previousStatus: {
      type: String,
      enum: [
        "open",
        "in_progress",
        "waiting_on_customer",
        "waiting_on_third_party",
        "resolved",
        "closed",
        "reopened",
        null,
      ],
      default: null,
    },
    newStatus: {
      type: String,
      enum: [
        "open",
        "in_progress",
        "waiting_on_customer",
        "waiting_on_third_party",
        "resolved",
        "closed",
        "reopened",
        null,
      ],
      default: null,
    },

    // Call tracking
    callDuration: {
      type: Number, // in seconds
      default: null,
    },
    callOutcome: {
      type: String,
      enum: [
        "connected",
        "no_answer",
        "voicemail",
        "busy",
        "wrong_number",
        null,
      ],
      default: null,
    },

    // Follow-up scheduling
    scheduledFollowUp: {
      type: Date,
      default: null,
    },

    // Visibility
    isInternal: {
      type: Boolean,
      default: false,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Indexes ────────────────────────────────────────────────
ticketRemarkSchema.index({ tenantId: 1, ticket: 1, createdAt: -1 });
ticketRemarkSchema.index({ ticket: 1, createdAt: -1 });
ticketRemarkSchema.index({ user: 1 });
ticketRemarkSchema.index({ type: 1 });

// ─── Static: Get remarks timeline ─────────────────────────
ticketRemarkSchema.statics.getTimeline = function (ticketId, options = {}) {
  const { limit = 50, page = 1, types = null } = options;

  const query = { ticket: ticketId };
  if (types && types.length > 0) {
    query.type = { $in: types };
  }

  const skip = (page - 1) * limit;

  return this.find(query)
    .sort({ isPinned: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("user", "name email avatar");
};

// ─── Static: Create status change remark ──────────────────
ticketRemarkSchema.statics.createStatusChangeRemark = async function (
  ticketId,
  userId,
  previousStatus,
  newStatus,
  note = "",
  tenantId = null,
) {
  return this.create({
    ticket: ticketId,
    user: userId,
    ...(tenantId ? { tenantId } : {}),
    content:
      note || `Status changed from ${previousStatus || "none"} to ${newStatus}`,
    type: "status_change",
    previousStatus,
    newStatus,
  });
};

// ─── Static: Create assignment change remark ──────────────
ticketRemarkSchema.statics.createAssignmentRemark = async function (
  ticketId,
  userId,
  assigneeName,
  note = "",
  tenantId = null,
) {
  return this.create({
    ticket: ticketId,
    user: userId,
    ...(tenantId ? { tenantId } : {}),
    content: note || `Ticket assigned to ${assigneeName}`,
    type: "assignment_change",
  });
};

const TicketRemark = mongoose.model("TicketRemark", ticketRemarkSchema);

export default TicketRemark;
