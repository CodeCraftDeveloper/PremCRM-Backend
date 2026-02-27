import mongoose from "mongoose";
import { LEAD_STATUSES } from "../constants/leadConstants.js";

const leadSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    // Lead personal info
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [50, "First name cannot exceed 50 characters"],
    },
    lastName: {
      type: String,
      trim: true,
      maxlength: [50, "Last name cannot exceed 50 characters"],
    },
    fullName: {
      type: String,
      trim: true,
      maxlength: [100, "Full name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      index: true,
    },
    message: {
      type: String,
      maxlength: [5000, "Message cannot exceed 5000 characters"],
    },
    // Lead source tracking
    websiteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Website",
      required: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      index: true, // e.g., "contact_form", "landing_page"
    },
    // Lead status tracking
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "new",
      index: true,
    },
    // Lead scoring
    score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      index: true,
    },
    // Assignment
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
    // Previously assigned users (history)
    previousAssignments: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        assignedAt: Date,
        assignmentDuration: Number, // in minutes
      },
    ],
    // Duplicate detection
    isDuplicate: {
      type: Boolean,
      default: false,
      index: true,
    },
    duplicateOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    mergeDuplicates: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Lead",
      },
    ],
    // Request tracking
    ipAddress: {
      type: String,
      trim: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
    // Additional fields
    country: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
    zipCode: {
      type: String,
      trim: true,
    },
    company: {
      type: String,
      trim: true,
    },
    productInterest: {
      type: String,
      trim: true,
    },
    // Custom fields (flexible for different sources)
    customFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    customData: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map(),
    },
    /** Flattened searchable custom field values for efficient queries */
    searchIndex: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Followup tracking
    lastContactedAt: {
      type: Date,
      default: null,
    },
    nextFollowUpDate: {
      type: Date,
      default: null,
      index: true,
    },
    contactAttempts: {
      type: Number,
      default: 0,
    },
    // Conversion tracking
    isConverted: {
      type: Boolean,
      default: false,
      index: true,
    },
    convertedAt: {
      type: Date,
      default: null,
    },
    convertedToContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },
    convertedToAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    convertedToDealId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deal",
      default: null,
    },
    conversionValue: {
      type: Number,
      default: 0,
    },
    // Meta
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    notes: {
      type: String,
      maxlength: [5000, "Notes cannot exceed 5000 characters"],
    },
    // File attachments
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
    // Activity tracking
    lastActivityAt: {
      type: Date,
      default: null,
    },
    // Soft delete support
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
  },
);

// Indices for query optimization
leadSchema.index({ tenantId: 1, status: 1 });
leadSchema.index({ tenantId: 1, assignedTo: 1 });
leadSchema.index({ tenantId: 1, websiteId: 1 });
leadSchema.index({ tenantId: 1, email: 1 });
leadSchema.index({ tenantId: 1, phone: 1 });
leadSchema.index({ tenantId: 1, isDuplicate: 1 });
leadSchema.index({ tenantId: 1, createdAt: -1 });
leadSchema.index({ tenantId: 1, nextFollowUpDate: 1 });
leadSchema.index({ email: 1, phone: 1 });

// Compound index for duplicate detection
leadSchema.index({
  tenantId: 1,
  email: 1,
  isDuplicate: 1,
});
leadSchema.index({
  tenantId: 1,
  phone: 1,
  isDuplicate: 1,
});

// Pre-save middleware to compute fullName
leadSchema.pre("save", function () {
  if (this.firstName) {
    this.fullName = this.lastName
      ? `${this.firstName} ${this.lastName}`
      : this.firstName;
  }
});

export default mongoose.model("Lead", leadSchema);
