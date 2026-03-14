import mongoose from "mongoose";
import crypto from "crypto";

const registrationSchema = new mongoose.Schema(
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
    ticketTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TicketType",
      required: true,
      index: true,
    },
    attendeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Attendee",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
      index: true,
    },
    legacyRegistrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EventRegistration",
      default: null,
      index: true,
      unique: true,
      sparse: true,
    },
    registrationNumber: {
      type: String,
      unique: true,
      index: true,
    },
    qrToken: { type: String, unique: true, index: true },
    quantity: {
      type: Number,
      default: 1,
      min: [1, "Quantity must be at least 1"],
    },
    subtotalAmount: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR", uppercase: true, maxlength: 3 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "checked_in", "no_show"],
      default: "confirmed",
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["free", "pending", "paid", "refunded", "failed"],
      default: "free",
      index: true,
    },
    couponCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CouponCode",
      default: null,
      index: true,
    },
    couponCode: { type: String, trim: true, uppercase: true, default: null },
    couponSnapshot: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    checkedInAt: { type: Date, default: null },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
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
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    customFields: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    source: {
      type: String,
      enum: ["web", "admin", "api"],
      default: "web",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

registrationSchema.pre("save", function () {
  if (!this.registrationNumber) {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.registrationNumber = `REG-${ts}-${rand}`;
  }
  if (!this.qrToken) {
    this.qrToken = crypto.randomBytes(24).toString("hex");
  }
});

registrationSchema.index({ tenantId: 1, eventId: 1, attendeeId: 1 });
registrationSchema.index({ tenantId: 1, eventId: 1, status: 1 });

export default mongoose.model("Registration", registrationSchema);
