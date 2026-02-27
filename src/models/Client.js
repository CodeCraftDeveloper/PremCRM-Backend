import mongoose from "mongoose";

const clientSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    // Basic Information
    name: {
      type: String,
      required: [true, "Client name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    companyName: {
      type: String,
      trim: true,
      maxlength: [200, "Company name cannot exceed 200 characters"],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
    },
    phone: {
      type: String,
      trim: true,
    },
    alternatePhone: {
      type: String,
      trim: true,
    },

    // Address Information
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
      pincode: { type: String, trim: true },
    },

    // CRM Fields
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: [true, "Event is required"],
    },
    marketingPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Marketing person is required"],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    followUpStatus: {
      type: String,
      enum: [
        "new",
        "contacted",
        "interested",
        "negotiation",
        "converted",
        "lost",
      ],
      default: "new",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    // Follow-up Tracking
    nextFollowUpDate: {
      type: Date,
      default: null,
    },
    lastContactedDate: {
      type: Date,
      default: null,
    },
    lastContactedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Business Information
    industry: {
      type: String,
      trim: true,
    },
    designation: {
      type: String,
      trim: true,
    },
    source: {
      type: String,
      enum: [
        "event",
        "referral",
        "website",
        "cold_call",
        "email",
        "social_media",
        "other",
      ],
      default: "event",
    },
    estimatedValue: {
      type: Number,
      default: 0,
      min: [0, "Estimated value cannot be negative"],
    },

    // Visiting Card
    visitingCard: {
      url: { type: String },
      key: { type: String },
      uploadedAt: { type: Date },
    },

    // Additional Information
    notes: {
      type: String,
      maxlength: [2000, "Notes cannot exceed 2000 characters"],
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],

    // Metadata
    isActive: {
      type: Boolean,
      default: true,
    },
    convertedDate: {
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
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for performance
clientSchema.index({ tenantId: 1, marketingPerson: 1 });
clientSchema.index({ tenantId: 1, createdBy: 1 });
clientSchema.index({ tenantId: 1, event: 1 });
clientSchema.index({ tenantId: 1, followUpStatus: 1 });
clientSchema.index({ tenantId: 1, priority: 1 });
clientSchema.index({ tenantId: 1, nextFollowUpDate: 1 });
clientSchema.index({ tenantId: 1, createdAt: -1 });
clientSchema.index({ tenantId: 1, isActive: 1 });
clientSchema.index({ name: "text", companyName: "text", email: "text" });

// Virtual to get remarks for this client
clientSchema.virtual("remarks", {
  ref: "Remark",
  localField: "_id",
  foreignField: "client",
});

// Virtual to get remark count
clientSchema.virtual("remarkCount", {
  ref: "Remark",
  localField: "_id",
  foreignField: "client",
  count: true,
});

// Virtual for full address
clientSchema.virtual("fullAddress").get(function () {
  const parts = [];
  if (this.address) {
    if (this.address.street) parts.push(this.address.street);
    if (this.address.city) parts.push(this.address.city);
    if (this.address.state) parts.push(this.address.state);
    if (this.address.country) parts.push(this.address.country);
    if (this.address.pincode) parts.push(this.address.pincode);
  }
  return parts.join(", ");
});

// Pre-save hook to update convertedDate
clientSchema.pre("save", function () {
  if (
    this.isModified("followUpStatus") &&
    this.followUpStatus === "converted" &&
    !this.convertedDate
  ) {
    this.convertedDate = new Date();
  }
});

// Keep convertedDate in sync for query-based updates (findByIdAndUpdate/findOneAndUpdate)
clientSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate() || {};
  const nextStatus = update.followUpStatus || update.$set?.followUpStatus;

  if (nextStatus === "converted") {
    if (!update.$set) update.$set = {};
    if (!update.$set.convertedDate) {
      update.$set.convertedDate = new Date();
    }
  }

  this.setUpdate(update);
});

// Static method to find pending follow-ups
clientSchema.statics.findPendingFollowUps = function (
  tenantId,
  userId = null,
  days = 7,
) {
  if (!tenantId)
    throw new Error("tenantId is required for findPendingFollowUps");
  const query = {
    tenantId,
    isActive: true,
    followUpStatus: { $nin: ["converted", "lost"] },
    nextFollowUpDate: {
      $ne: null,
      $lte: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
  };

  if (userId) {
    query.marketingPerson = userId;
  }

  return this.find(query).sort({ nextFollowUpDate: 1 });
};

// Static method to get statistics
clientSchema.statics.getStats = async function (filter = {}) {
  if (!filter.tenantId)
    throw new Error("tenantId is required in filter for getStats");
  const matchStage = { isActive: true, ...filter };

  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$followUpStatus",
        count: { $sum: 1 },
        totalValue: { $sum: "$estimatedValue" },
      },
    },
  ]);

  const result = {
    total: 0,
    new: 0,
    contacted: 0,
    interested: 0,
    negotiation: 0,
    converted: 0,
    lost: 0,
    totalValue: 0,
    convertedValue: 0,
  };

  stats.forEach((stat) => {
    result[stat._id] = stat.count;
    result.total += stat.count;
    result.totalValue += stat.totalValue;
    if (stat._id === "converted") {
      result.convertedValue = stat.totalValue;
    }
  });

  return result;
};

const Client = mongoose.model("Client", clientSchema);

export default Client;
