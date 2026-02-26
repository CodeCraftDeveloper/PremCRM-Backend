import mongoose from "mongoose";

const leadRemarkSchema = new mongoose.Schema(
  {
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: [true, "Lead is required"],
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
      maxlength: [2000, "Remark cannot exceed 2000 characters"],
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
        "system",
      ],
      default: "note",
    },
    // For status change tracking
    previousStatus: {
      type: String,
      enum: [
        "new",
        "contacted",
        "interested",
        "qualified",
        "closed",
        "lost",
        null,
      ],
      default: null,
    },
    newStatus: {
      type: String,
      enum: [
        "new",
        "contacted",
        "interested",
        "qualified",
        "closed",
        "lost",
        null,
      ],
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

// Indexes
leadRemarkSchema.index({ lead: 1, createdAt: -1 });
leadRemarkSchema.index({ user: 1 });
leadRemarkSchema.index({ type: 1 });

// Static method to get remarks timeline for a lead
leadRemarkSchema.statics.getTimeline = function (leadId, options = {}) {
  const { limit = 50, page = 1, types = null } = options;

  const query = { lead: leadId };
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

// Static to create status change remark
leadRemarkSchema.statics.createStatusChangeRemark = async function (
  leadId,
  userId,
  previousStatus,
  newStatus,
) {
  return this.create({
    lead: leadId,
    user: userId,
    content: `Status changed from ${previousStatus || "none"} to ${newStatus}`,
    type: "status_change",
    previousStatus,
    newStatus,
  });
};

const LeadRemark = mongoose.model("LeadRemark", leadRemarkSchema);

export default LeadRemark;
