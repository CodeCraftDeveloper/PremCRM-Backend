import mongoose from "mongoose";

const ticketTypeSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Ticket type name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: [0, "Price cannot be negative"],
      default: 0,
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    // null = unlimited
    capacity: {
      type: Number,
      min: [1, "Capacity must be at least 1"],
      default: null,
    },
    sold: {
      type: Number,
      default: 0,
      min: 0,
    },
    waitlistEnabled: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["active", "paused", "sold_out"],
      default: "active",
      index: true,
    },
    saleStartDate: { type: Date, default: null },
    saleEndDate: { type: Date, default: null },
    perOrderMin: { type: Number, default: 1, min: 1 },
    perOrderMax: { type: Number, default: 10, min: 1 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

ticketTypeSchema.virtual("available").get(function () {
  if (this.capacity == null) return null;
  return Math.max(0, this.capacity - this.sold);
});

ticketTypeSchema.virtual("isSoldOut").get(function () {
  if (this.capacity == null) return false;
  return this.sold >= this.capacity;
});

ticketTypeSchema.index({ eventId: 1, tenantId: 1 });

export default mongoose.model("TicketType", ticketTypeSchema);
