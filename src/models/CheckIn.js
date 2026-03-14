import mongoose from "mongoose";

const checkInSchema = new mongoose.Schema(
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
    registrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Registration",
      default: null,
      index: true,
    },
    legacyRegistrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EventRegistration",
      required: true,
      unique: true,
      index: true,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    checkedInAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    channel: {
      type: String,
      enum: ["qr", "manual", "api"],
      default: "qr",
    },
    scanCode: { type: String, trim: true, default: "" },
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

checkInSchema.index({ tenantId: 1, eventId: 1, checkedInAt: -1 });

export default mongoose.model("CheckIn", checkInSchema);
