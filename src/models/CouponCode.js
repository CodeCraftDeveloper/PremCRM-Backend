import mongoose from "mongoose";

const couponCodeSchema = new mongoose.Schema(
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
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      trim: true,
      uppercase: true,
      maxlength: [32, "Coupon code cannot exceed 32 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [240, "Description cannot exceed 240 characters"],
      default: "",
    },
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      required: true,
      default: "percentage",
    },
    discountValue: {
      type: Number,
      required: true,
      min: [0, "Discount value cannot be negative"],
    },
    maxDiscountAmount: {
      type: Number,
      default: null,
      min: [0, "Max discount cannot be negative"],
    },
    minQuantity: {
      type: Number,
      default: 1,
      min: [1, "Minimum quantity must be at least 1"],
    },
    maxUses: {
      type: Number,
      default: null,
      min: [1, "Max uses must be at least 1"],
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    applicableTicketTypeIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "TicketType",
      },
    ],
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

couponCodeSchema.index({ tenantId: 1, eventId: 1, code: 1 }, { unique: true });

export default mongoose.model("CouponCode", couponCodeSchema);
