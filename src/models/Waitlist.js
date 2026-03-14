import mongoose from "mongoose";

const waitlistSchema = new mongoose.Schema(
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
    },
    position: { type: Number, index: true },
    status: {
      type: String,
      enum: ["waiting", "notified", "converted", "expired"],
      default: "waiting",
      index: true,
    },
    notifiedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

waitlistSchema.index({ eventId: 1, ticketTypeId: 1, status: 1 });
waitlistSchema.index({ "attendee.email": 1, eventId: 1, ticketTypeId: 1 });

export default mongoose.model("Waitlist", waitlistSchema);
