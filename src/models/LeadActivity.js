import mongoose from "mongoose";

const leadActivitySchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "created",
        "status_changed",
        "assigned",
        "reassigned",
        "contacted",
        "duplicate_detected",
        "merged",
        "note_added",
        "score_updated",
        "tag_added",
        "converted",
        "qualification_updated",
      ],
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    // For tracking changes
    previousValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Who performed the action (system or user)
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    performedByName: {
      type: String,
      default: "System",
    },
    // Related entities
    relatedLeadId: {
      // For merge, linked lead
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    // Metadata
    metadata: {
      ipAddress: String,
      userAgent: String,
      customData: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Indices
leadActivitySchema.index({ tenantId: 1, leadId: 1, createdAt: -1 });
leadActivitySchema.index({ tenantId: 1, action: 1, createdAt: -1 });
leadActivitySchema.index({ tenantId: 1, performedBy: 1, createdAt: -1 });

export default mongoose.model("LeadActivity", leadActivitySchema);
