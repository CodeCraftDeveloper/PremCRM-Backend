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
    },
    registrationNumber: {
      type: String,
      unique: true,
      index: true,
    },
    attendee: {
      firstName: {
        type: String,
        required: [true, "First name is required"],
        trim: true,
        maxlength: 50,
      },
      lastName: { type: String, trim: true, maxlength: 50, default: "" },
      email: {
        type: String,
        required: [true, "Email is required"],
        trim: true,
        lowercase: true,
        maxlength: 254,
        match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
      },
      phone: { type: String, trim: true, maxlength: 20, default: "" },
      company: { type: String, trim: true, maxlength: 100, default: "" },
    },
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
    paymentReference: { type: String, trim: true, default: null },
    // Unique token embedded in QR code for check-in
    qrToken: { type: String, unique: true, index: true },
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
    // Stored separately; excluded from default projections
    ipAddress: { type: String, default: null, select: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Auto-generate registration number and secure QR token before first save
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

registrationSchema.index({ eventId: 1, tenantId: 1 });
registrationSchema.index({ "attendee.email": 1, eventId: 1 });

export default mongoose.model("EventRegistration", registrationSchema);
