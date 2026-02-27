import mongoose from "mongoose";

const remarkSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: [true, "Tenant ID is required"],
      index: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: [true, "Client is required"],
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
        "negotiation",
        "converted",
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
        "negotiation",
        "converted",
        "lost",
        null,
      ],
      default: null,
    },
    // Attachments
    attachments: [
      {
        name: String,
        url: String,
        key: String,
        type: String,
        size: Number,
      },
    ],
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

// Indexes for performance
remarkSchema.index({ tenantId: 1, client: 1, createdAt: -1 });
remarkSchema.index({ client: 1, createdAt: -1 });
remarkSchema.index({ user: 1 });
remarkSchema.index({ type: 1 });
remarkSchema.index({ createdAt: -1 });

// Static method to get remarks timeline
remarkSchema.statics.getTimeline = function (tenantId, clientId, options = {}) {
  if (!tenantId) throw new Error("tenantId is required for getTimeline");
  const { limit = 50, page = 1, types = null } = options;

  const query = { tenantId, client: clientId };
  if (types && types.length > 0) {
    query.type = { $in: types };
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("user", "name email avatar");
};

// Static method to create status change remark
remarkSchema.statics.createStatusChangeRemark = async function (
  tenantId,
  clientId,
  userId,
  previousStatus,
  newStatus,
) {
  if (!tenantId)
    throw new Error("tenantId is required for createStatusChangeRemark");
  return this.create({
    tenantId,
    client: clientId,
    user: userId,
    content: `Status changed from "${previousStatus}" to "${newStatus}"`,
    type: "status_change",
    previousStatus,
    newStatus,
  });
};

const Remark = mongoose.model("Remark", remarkSchema);

export default Remark;
