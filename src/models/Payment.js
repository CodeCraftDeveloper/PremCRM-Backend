import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
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
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR", uppercase: true, maxlength: 3 },
    status: {
      type: String,
      enum: ["free", "pending", "paid", "refunded", "failed"],
      default: "pending",
      index: true,
    },
    method: {
      type: String,
      enum: ["free", "card", "upi", "bank_transfer", "cash", "other"],
      default: "other",
    },
    provider: { type: String, trim: true, maxlength: 80, default: "" },
    transactionId: { type: String, trim: true, default: null, index: true },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundReason: { type: String, trim: true, maxlength: 500, default: "" },
    failureReason: { type: String, trim: true, maxlength: 500, default: "" },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

paymentSchema.index({ tenantId: 1, eventId: 1, status: 1 });

export default mongoose.model("Payment", paymentSchema);
