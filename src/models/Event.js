import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Event name is required"],
      trim: true,
      maxlength: [200, "Event name cannot exceed 200 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, "Description cannot exceed 2000 characters"],
    },
    location: {
      type: String,
      trim: true,
      maxlength: [500, "Location cannot exceed 500 characters"],
    },
    startDate: {
      type: Date,
      required: [true, "Start date is required"],
    },
    endDate: {
      type: Date,
      required: [true, "End date is required"],
    },
    status: {
      type: String,
      enum: ["upcoming", "active", "completed", "cancelled"],
      default: "upcoming",
      index: true,
    },
    targetLeads: {
      type: Number,
      default: 0,
      min: [0, "Target leads cannot be negative"],
    },
    budget: {
      type: Number,
      default: 0,
      min: [0, "Budget cannot be negative"],
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    image: {
      type: String,
      default: null,
    },
    landing: {
      heroImageUrl: {
        type: String,
        trim: true,
        maxlength: [500, "Hero image URL cannot exceed 500 characters"],
        default: "",
      },
      heroTagline: {
        type: String,
        trim: true,
        maxlength: [160, "Hero tagline cannot exceed 160 characters"],
        default: "",
      },
      accentColor: {
        type: String,
        trim: true,
        maxlength: [20, "Accent color cannot exceed 20 characters"],
        default: "",
      },
    },
    registrationFields: [
      {
        key: {
          type: String,
          required: true,
          trim: true,
          maxlength: [60, "Field key cannot exceed 60 characters"],
        },
        label: {
          type: String,
          required: true,
          trim: true,
          maxlength: [120, "Field label cannot exceed 120 characters"],
        },
        type: {
          type: String,
          enum: ["text", "textarea", "select", "number", "date", "url"],
          default: "text",
        },
        required: {
          type: Boolean,
          default: false,
        },
        placeholder: {
          type: String,
          trim: true,
          maxlength: [160, "Placeholder cannot exceed 160 characters"],
          default: "",
        },
        helpText: {
          type: String,
          trim: true,
          maxlength: [200, "Help text cannot exceed 200 characters"],
          default: "",
        },
        options: [
          {
            type: String,
            trim: true,
            maxlength: [120, "Option text cannot exceed 120 characters"],
          },
        ],
        maxLength: {
          type: Number,
          min: 1,
          max: 2000,
          default: null,
        },
        sortOrder: {
          type: Number,
          default: 0,
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for performance
eventSchema.index({ tenantId: 1, status: 1 });
eventSchema.index({ tenantId: 1, startDate: 1, endDate: 1 });
eventSchema.index({ tenantId: 1, createdAt: -1 });
eventSchema.index({ name: "text", description: "text" });

// Virtual to get client count for this event
eventSchema.virtual("clientCount", {
  ref: "Client",
  localField: "_id",
  foreignField: "event",
  count: true,
});

// Virtual to check if event is currently active
eventSchema.virtual("isCurrentlyActive").get(function () {
  const now = new Date();
  return (
    this.status === "active" && now >= this.startDate && now <= this.endDate
  );
});

// Pre-save hook to auto-update status based on dates
eventSchema.pre("save", function () {
  const now = new Date();

  if (this.status !== "cancelled") {
    if (now < this.startDate) {
      this.status = "upcoming";
    } else if (now >= this.startDate && now <= this.endDate) {
      this.status = "active";
    } else if (now > this.endDate) {
      this.status = "completed";
    }
  }
});

// Keep status auto-sync for query-based updates (findByIdAndUpdate/findOneAndUpdate)
eventSchema.pre("findOneAndUpdate", async function () {
  const update = this.getUpdate() || {};

  const event = await this.model
    .findOne(this.getQuery())
    .select("startDate endDate status");

  if (!event) return;

  const nextStartDate =
    update.startDate || update.$set?.startDate || event.startDate;
  const nextEndDate = update.endDate || update.$set?.endDate || event.endDate;
  const requestedStatus = update.status || update.$set?.status || event.status;

  if (requestedStatus !== "cancelled") {
    const now = new Date();
    let computedStatus = "upcoming";

    if (now >= nextStartDate && now <= nextEndDate) {
      computedStatus = "active";
    } else if (now > nextEndDate) {
      computedStatus = "completed";
    }

    if (!update.$set) update.$set = {};
    update.$set.status = computedStatus;
  }

  this.setUpdate(update);
});

// Static method to find active events
eventSchema.statics.findActiveEvents = function (tenantId) {
  if (!tenantId) throw new Error("tenantId is required for findActiveEvents");
  const now = new Date();
  return this.find({
    tenantId,
    status: { $in: ["upcoming", "active"] },
    endDate: { $gte: now },
  }).sort({ startDate: 1 });
};

// Static method to find events by date range
eventSchema.statics.findByDateRange = function (tenantId, startDate, endDate) {
  if (!tenantId) throw new Error("tenantId is required for findByDateRange");
  return this.find({
    tenantId,
    $or: [
      { startDate: { $gte: startDate, $lte: endDate } },
      { endDate: { $gte: startDate, $lte: endDate } },
      { startDate: { $lte: startDate }, endDate: { $gte: endDate } },
    ],
  });
};

const Event = mongoose.model("Event", eventSchema);

export default Event;
