import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
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
    attendeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Attendee",
      required: true,
      index: true,
    },
    orderNumber: {
      type: String,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "pending", "confirmed", "cancelled", "refunded"],
      default: "pending",
      index: true,
    },
    subtotalAmount: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR", uppercase: true, maxlength: 3 },
    couponCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CouponCode",
      default: null,
      index: true,
    },
    couponCode: { type: String, trim: true, uppercase: true, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancelReason: { type: String, trim: true, maxlength: 500, default: "" },
    refundedAt: { type: Date, default: null },
    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundReason: { type: String, trim: true, maxlength: 500, default: "" },
    source: {
      type: String,
      enum: ["web", "admin", "api"],
      default: "web",
    },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

orderSchema.pre("save", function () {
  if (!this.orderNumber) {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.orderNumber = `ORD-${ts}-${rand}`;
  }
});

orderSchema.index({ tenantId: 1, eventId: 1, createdAt: -1 });

export default mongoose.model("Order", orderSchema);
