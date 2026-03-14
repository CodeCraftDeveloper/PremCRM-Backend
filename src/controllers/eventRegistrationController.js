import Event from "../models/Event.js";
import TicketType from "../models/TicketType.js";
import EventRegistration from "../models/EventRegistration.js";
import Attendee from "../models/Attendee.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import Registration from "../models/Registration.js";
import CheckIn from "../models/CheckIn.js";
import Waitlist from "../models/Waitlist.js";
import CouponCode from "../models/CouponCode.js";
import mongoose from "mongoose";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify the event exists and belongs to the authenticated tenant.
 * Throws 404 if not found.
 */
const getOwnedEvent = async (eventId, tenantId) => {
  const event = await Event.findOne({ _id: eventId, tenantId }).lean();
  if (!event) throw ApiError.notFound("Event not found");
  return event;
};

const parsePagination = (page = 1, limit = 20) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return {
    page: parsedPage,
    limit: parsedLimit,
    skip: (parsedPage - 1) * parsedLimit,
  };
};

const syncTicketAvailability = async (ticketTypeId) => {
  const ticketType = await TicketType.findById(ticketTypeId)
    .select("capacity sold status")
    .lean();

  if (!ticketType || ticketType.status === "paused") return;

  if (ticketType.capacity == null) {
    if (ticketType.status === "sold_out") {
      await TicketType.findByIdAndUpdate(ticketTypeId, { status: "active" });
    }
    return;
  }

  const nextStatus =
    ticketType.sold >= ticketType.capacity ? "sold_out" : "active";
  if (nextStatus !== ticketType.status) {
    await TicketType.findByIdAndUpdate(ticketTypeId, { status: nextStatus });
  }
};

const releaseTicketInventory = async (ticketTypeId, quantity) => {
  if (!quantity) return;
  await TicketType.findByIdAndUpdate(ticketTypeId, {
    $inc: { sold: -Math.max(0, quantity) },
  });
  await TicketType.findByIdAndUpdate(
    ticketTypeId,
    [
      {
        $set: {
          sold: {
            $cond: [{ $lt: ["$sold", 0] }, 0, "$sold"],
          },
        },
      },
    ],
    { updatePipeline: true },
  );
  await syncTicketAvailability(ticketTypeId);
};

const reserveTicketInventory = async (ticketTypeId, quantity) => {
  if (!quantity) return;
  const ticketType = await TicketType.findById(ticketTypeId)
    .select("capacity sold")
    .lean();

  if (!ticketType) {
    throw ApiError.notFound("Ticket type not found");
  }

  if (ticketType.capacity != null) {
    const remaining = ticketType.capacity - ticketType.sold;
    if (remaining < quantity) {
      throw ApiError.badRequest(
        remaining <= 0
          ? "No seats remain for this ticket type"
          : `Only ${remaining} seat(s) remain for this ticket type`,
      );
    }
  }

  await TicketType.findByIdAndUpdate(ticketTypeId, {
    $inc: { sold: quantity },
  });
  await syncTicketAvailability(ticketTypeId);
};

// ─── Ticket Types ─────────────────────────────────────────────────────────────

/**
 * @desc    List ticket types for an event
 * @route   GET /api/events/:id/ticket-types
 * @access  Private
 */
export const listTicketTypes = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const ticketTypes = await TicketType.find({
    eventId: req.params.id,
    tenantId,
  }).sort({ createdAt: 1 });

  successResponse(res, { ticketTypes }, "Ticket types retrieved");
});

/**
 * @desc    Create a ticket type
 * @route   POST /api/events/:id/ticket-types
 * @access  Private/Admin
 */
export const createTicketType = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const {
    name,
    description,
    price,
    currency,
    capacity,
    waitlistEnabled,
    saleStartDate,
    saleEndDate,
    perOrderMin,
    perOrderMax,
  } = req.body;

  const ticketType = await TicketType.create({
    tenantId,
    eventId: req.params.id,
    name,
    description,
    price: price ?? 0,
    currency: currency || "INR",
    capacity: capacity ?? null,
    waitlistEnabled: waitlistEnabled ?? false,
    saleStartDate: saleStartDate || null,
    saleEndDate: saleEndDate || null,
    perOrderMin: perOrderMin ?? 1,
    perOrderMax: perOrderMax ?? 10,
  });

  successResponse(res, { ticketType }, "Ticket type created", 201);
});

/**
 * @desc    Update a ticket type
 * @route   PUT /api/events/:id/ticket-types/:ttId
 * @access  Private/Admin
 */
export const updateTicketType = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const ticketType = await TicketType.findOneAndUpdate(
    { _id: req.params.ttId, eventId: req.params.id, tenantId },
    { $set: req.body },
    { new: true, runValidators: true },
  );

  if (!ticketType) throw ApiError.notFound("Ticket type not found");

  successResponse(res, { ticketType }, "Ticket type updated");
});

/**
 * @desc    Delete a ticket type
 * @route   DELETE /api/events/:id/ticket-types/:ttId
 * @access  Private/Admin
 */
export const deleteTicketType = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const hasRegistrations = await EventRegistration.exists({
    ticketTypeId: req.params.ttId,
    status: { $in: ["confirmed", "pending", "checked_in"] },
  });

  if (hasRegistrations) {
    throw ApiError.conflict(
      "Cannot delete a ticket type that has active registrations",
    );
  }

  const deleted = await TicketType.findOneAndDelete({
    _id: req.params.ttId,
    eventId: req.params.id,
    tenantId,
  });

  if (!deleted) throw ApiError.notFound("Ticket type not found");

  successResponse(res, null, "Ticket type deleted");
});

// ─── Registrations ────────────────────────────────────────────────────────────

/**
 * @desc    List registrations for an event (paginated)
 * @route   GET /api/events/:id/registrations
 * @access  Private
 */
export const listRegistrations = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { page = 1, limit = 20, status, ticketTypeId, search } = req.query;

  const query = { eventId: req.params.id, tenantId };
  if (status) query.status = status;
  if (ticketTypeId) query.ticketTypeId = ticketTypeId;
  if (search) {
    query.$or = [
      { registrationNumber: { $regex: search, $options: "i" } },
      { "attendee.firstName": { $regex: search, $options: "i" } },
      { "attendee.lastName": { $regex: search, $options: "i" } },
      { "attendee.email": { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [registrations, totalDocs] = await Promise.all([
    EventRegistration.find(query)
      .populate("ticketTypeId", "name price currency")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    EventRegistration.countDocuments(query),
  ]);

  paginatedResponse(res, registrations, {
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(totalDocs / parseInt(limit)),
    totalDocs,
  });
});

/**
 * @desc    Get single registration
 * @route   GET /api/events/:id/registrations/:regId
 * @access  Private
 */
export const getRegistration = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const registration = await EventRegistration.findOne({
    _id: req.params.regId,
    eventId: req.params.id,
    tenantId,
  })
    .populate("ticketTypeId", "name price currency")
    .populate("checkedInBy", "name email");

  if (!registration) throw ApiError.notFound("Registration not found");

  successResponse(res, { registration });
});

/**
 * @desc    Update registration status (admin override)
 * @route   PATCH /api/events/:id/registrations/:regId/status
 * @access  Private/Admin
 */
export const updateRegistrationStatus = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { status, reason = "" } = req.body;
  const allowed = ["pending", "confirmed", "cancelled", "no_show"];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(`Status must be one of: ${allowed.join(", ")}`);
  }

  const registration = await EventRegistration.findOne({
    _id: req.params.regId,
    eventId: req.params.id,
    tenantId,
  });

  if (!registration) throw ApiError.notFound("Registration not found");

  const previousStatus = registration.status;
  if (previousStatus === status) {
    return successResponse(
      res,
      { registration },
      "Registration status updated",
    );
  }

  if (previousStatus !== "cancelled" && status === "cancelled") {
    await releaseTicketInventory(
      registration.ticketTypeId,
      registration.quantity,
    );
    registration.cancelledAt = new Date();
    registration.cancelledBy = req.user._id;
    registration.cancelReason = String(reason || "").trim();
  }

  if (previousStatus === "cancelled" && status !== "cancelled") {
    await reserveTicketInventory(
      registration.ticketTypeId,
      registration.quantity,
    );
    registration.cancelledAt = null;
    registration.cancelledBy = null;
    registration.cancelReason = "";
  }

  registration.status = status;
  await registration.save();

  const domainRegistration = await Registration.findOneAndUpdate(
    {
      legacyRegistrationId: registration._id,
      eventId: req.params.id,
      tenantId,
    },
    {
      $set: {
        status,
        cancelledAt: registration.cancelledAt,
        cancelledBy: registration.cancelledBy,
        cancelReason: registration.cancelReason,
      },
    },
  );

  if (status === "cancelled") {
    await Order.findOneAndUpdate(
      {
        eventId: req.params.id,
        tenantId,
        _id: domainRegistration?.orderId,
      },
      {
        $set: {
          status:
            registration.paymentStatus === "refunded"
              ? "refunded"
              : "cancelled",
          cancelledAt: registration.cancelledAt,
          cancelledBy: registration.cancelledBy,
          cancelReason: registration.cancelReason,
        },
      },
    );
  }

  successResponse(res, { registration }, "Registration status updated");
});

/**
 * @desc    Refund a registration payment and track cancellation/refund metadata
 * @route   PATCH /api/events/:id/registrations/:regId/refund
 * @access  Private/Admin
 */
export const refundRegistration = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { reason = "", refundAmount } = req.body;

  const registration = await EventRegistration.findOne({
    _id: req.params.regId,
    eventId: req.params.id,
    tenantId,
  });

  if (!registration) throw ApiError.notFound("Registration not found");
  if (registration.paymentStatus === "refunded") {
    throw ApiError.conflict("This registration has already been refunded");
  }

  const normalizedRefundAmount =
    refundAmount == null ? registration.totalAmount : Number(refundAmount);

  if (!Number.isFinite(normalizedRefundAmount) || normalizedRefundAmount < 0) {
    throw ApiError.badRequest("Refund amount must be a non-negative number");
  }
  if (normalizedRefundAmount > registration.totalAmount) {
    throw ApiError.badRequest("Refund amount cannot exceed total amount paid");
  }

  const now = new Date();
  const trimmedReason = String(reason || "").trim();
  const shouldReleaseInventory = registration.status !== "cancelled";

  if (shouldReleaseInventory) {
    await releaseTicketInventory(
      registration.ticketTypeId,
      registration.quantity,
    );
    registration.status = "cancelled";
    registration.cancelledAt = now;
    registration.cancelledBy = req.user._id;
    registration.cancelReason = trimmedReason || registration.cancelReason;
  }

  registration.paymentStatus = "refunded";
  registration.refundedAt = now;
  registration.refundedBy = req.user._id;
  registration.refundAmount = normalizedRefundAmount;
  registration.refundReason = trimmedReason;
  await registration.save();

  const domainRegistration = await Registration.findOneAndUpdate(
    {
      legacyRegistrationId: registration._id,
      eventId: req.params.id,
      tenantId,
    },
    {
      $set: {
        status: registration.status,
        paymentStatus: "refunded",
        cancelledAt: registration.cancelledAt,
        cancelledBy: registration.cancelledBy,
        cancelReason: registration.cancelReason,
        refundedAt: now,
        refundedBy: req.user._id,
        refundAmount: normalizedRefundAmount,
        refundReason: trimmedReason,
      },
    },
    { new: true },
  );

  if (domainRegistration?.orderId) {
    await Order.findOneAndUpdate(
      { _id: domainRegistration.orderId, eventId: req.params.id, tenantId },
      {
        $set: {
          status: "refunded",
          cancelledAt: registration.cancelledAt,
          cancelledBy: registration.cancelledBy,
          cancelReason: registration.cancelReason,
          refundedAt: now,
          refundedBy: req.user._id,
          refundAmount: normalizedRefundAmount,
          refundReason: trimmedReason,
        },
      },
    );
  }

  if (domainRegistration?.paymentId) {
    await Payment.findOneAndUpdate(
      { _id: domainRegistration.paymentId, eventId: req.params.id, tenantId },
      {
        $set: {
          status: "refunded",
          refundedAt: now,
          refundedBy: req.user._id,
          refundAmount: normalizedRefundAmount,
          refundReason: trimmedReason,
        },
      },
    );
  }

  successResponse(res, { registration }, "Registration refunded successfully");
});

/**
 * @desc    Update attendee details for a registration
 * @route   PATCH /api/events/:id/registrations/:regId/attendee
 * @access  Private/Admin
 */
export const updateRegistrationAttendee = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const registration = await EventRegistration.findOne({
    _id: req.params.regId,
    eventId: req.params.id,
    tenantId,
  });

  if (!registration) throw ApiError.notFound("Registration not found");

  const nextAttendee = {
    ...registration.attendee.toObject(),
  };

  if (req.body.firstName !== undefined) {
    nextAttendee.firstName = String(req.body.firstName).trim();
  }

  if (req.body.lastName !== undefined) {
    nextAttendee.lastName = String(req.body.lastName).trim();
  }

  if (req.body.email !== undefined) {
    nextAttendee.email = String(req.body.email).trim().toLowerCase();
  }

  if (req.body.phone !== undefined) {
    nextAttendee.phone = String(req.body.phone).trim();
  }

  if (req.body.company !== undefined) {
    nextAttendee.company = String(req.body.company).trim();
  }

  if (req.body.notes !== undefined) {
    registration.notes = String(req.body.notes).trim();
  }

  if (!nextAttendee.firstName) {
    throw ApiError.badRequest("First name is required");
  }

  if (!nextAttendee.email) {
    throw ApiError.badRequest("Email is required");
  }

  const duplicate = await EventRegistration.exists({
    _id: { $ne: registration._id },
    eventId: req.params.id,
    tenantId,
    "attendee.email": nextAttendee.email,
    status: { $ne: "cancelled" },
  });

  if (duplicate) {
    throw ApiError.conflict(
      "Another active registration already uses this attendee email",
    );
  }

  registration.attendee = nextAttendee;
  await registration.save();

  const updated = await EventRegistration.findById(registration._id)
    .populate("ticketTypeId", "name price currency")
    .populate("checkedInBy", "name email")
    .lean();

  successResponse(
    res,
    { registration: updated },
    "Attendee details updated successfully",
  );
});

/**
 * @desc    Check in an attendee by QR token
 * @route   POST /api/events/:id/checkin
 * @access  Private
 */
export const checkInAttendee = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const code = String(req.body.qrToken || "").trim();
  if (!code)
    throw ApiError.badRequest("QR token or registration number is required");

  const normalizedRegNumber = code.toUpperCase();
  const isQrToken = /^[0-9a-f]{48}$/i.test(code);

  const registration = await EventRegistration.findOne({
    $or: isQrToken
      ? [{ qrToken: code }, { registrationNumber: normalizedRegNumber }]
      : [{ registrationNumber: normalizedRegNumber }],
    eventId: req.params.id,
    tenantId,
  }).populate("ticketTypeId", "name");

  if (!registration)
    throw ApiError.notFound(
      "Invalid QR code / registration number — registration not found",
    );

  if (registration.status === "cancelled") {
    throw ApiError.badRequest("This registration has been cancelled");
  }
  if (registration.status === "checked_in") {
    return successResponse(
      res,
      { registration, alreadyCheckedIn: true },
      `Already checked in at ${registration.checkedInAt.toISOString()}`,
    );
  }

  registration.status = "checked_in";
  registration.checkedInAt = new Date();
  registration.checkedInBy = req.user._id;
  await registration.save();

  const domainRegistration = await Registration.findOneAndUpdate(
    {
      legacyRegistrationId: registration._id,
      eventId: req.params.id,
      tenantId,
    },
    {
      $set: {
        status: "checked_in",
        checkedInAt: registration.checkedInAt,
        checkedInBy: req.user._id,
      },
    },
    { new: true },
  ).select("_id");

  await CheckIn.findOneAndUpdate(
    { legacyRegistrationId: registration._id },
    {
      $set: {
        tenantId,
        eventId: req.params.id,
        registrationId: domainRegistration?._id ?? null,
        checkedInBy: req.user._id,
        checkedInAt: registration.checkedInAt,
        channel: /^[0-9a-f]{48}$/i.test(code) ? "qr" : "manual",
        scanCode: code,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  successResponse(
    res,
    { registration, alreadyCheckedIn: false },
    "Check-in successful",
  );
});

// ─── Waitlist ─────────────────────────────────────────────────────────────────

/**
 * @desc    List waitlist entries for an event
 * @route   GET /api/events/:id/waitlist
 * @access  Private
 */
export const listWaitlist = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { ticketTypeId, status } = req.query;
  const query = { eventId: req.params.id, tenantId };
  if (ticketTypeId) query.ticketTypeId = ticketTypeId;
  if (status) query.status = status;

  const entries = await Waitlist.find(query)
    .populate("ticketTypeId", "name")
    .sort({ position: 1 });

  successResponse(res, { waitlist: entries });
});

/**
 * @desc    Update waitlist entry status (e.g., notified → converted/expired)
 * @route   PATCH /api/events/:id/waitlist/:entryId/status
 * @access  Private/Admin
 */
export const updateWaitlistStatus = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { status } = req.body;
  const allowed = ["notified", "converted", "expired"];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(`Status must be one of: ${allowed.join(", ")}`);
  }

  const update = { status };
  if (status === "notified") update.notifiedAt = new Date();

  const entry = await Waitlist.findOneAndUpdate(
    { _id: req.params.entryId, eventId: req.params.id, tenantId },
    { $set: update },
    { new: true },
  );

  if (!entry) throw ApiError.notFound("Waitlist entry not found");

  successResponse(res, { entry }, "Waitlist entry updated");
});

/**
 * @desc    Get registration summary stats for an event
 * @route   GET /api/events/:id/registrations/stats
 * @access  Private
 */
export const getRegistrationStats = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const [
    statusAgg,
    paymentStatusAgg,
    ticketAgg,
    revenueAgg,
    seatAgg,
    waitlistCount,
  ] = await Promise.all([
    EventRegistration.aggregate([
      {
        $match: {
          eventId: new (await import("mongoose")).default.Types.ObjectId(
            req.params.id,
          ),
          tenantId,
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    EventRegistration.aggregate([
      {
        $match: {
          eventId: new (await import("mongoose")).default.Types.ObjectId(
            req.params.id,
          ),
          tenantId,
        },
      },
      { $group: { _id: "$paymentStatus", count: { $sum: 1 } } },
    ]),
    EventRegistration.aggregate([
      {
        $match: {
          eventId: new (await import("mongoose")).default.Types.ObjectId(
            req.params.id,
          ),
          tenantId,
          status: { $ne: "cancelled" },
        },
      },
      {
        $group: {
          _id: "$ticketTypeId",
          count: { $sum: "$quantity" },
          revenue: { $sum: "$totalAmount" },
        },
      },
      {
        $lookup: {
          from: "tickettypes",
          localField: "_id",
          foreignField: "_id",
          as: "ticketType",
          pipeline: [{ $project: { name: 1, price: 1 } }],
        },
      },
      { $unwind: { path: "$ticketType", preserveNullAndEmpty: true } },
    ]),
    EventRegistration.aggregate([
      {
        $match: {
          eventId: new (await import("mongoose")).default.Types.ObjectId(
            req.params.id,
          ),
          tenantId,
          status: { $ne: "cancelled" },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
          count: { $sum: "$quantity" },
        },
      },
    ]),
    TicketType.aggregate([
      {
        $match: {
          eventId: new mongoose.Types.ObjectId(req.params.id),
          tenantId,
        },
      },
      {
        $group: {
          _id: null,
          sold: { $sum: "$sold" },
          capacity: {
            $sum: {
              $cond: [{ $ifNull: ["$capacity", false] }, "$capacity", 0],
            },
          },
          limitedTicketTypes: {
            $sum: { $cond: [{ $ifNull: ["$capacity", false] }, 1, 0] },
          },
        },
      },
    ]),
    Waitlist.countDocuments({
      eventId: req.params.id,
      tenantId,
      status: { $in: ["waiting", "notified"] },
    }),
  ]);

  const statsByStatus = Object.fromEntries(
    statusAgg.map((s) => [s._id, s.count]),
  );
  const statsByPaymentStatus = Object.fromEntries(
    paymentStatusAgg.map((s) => [s._id, s.count]),
  );
  const totals = revenueAgg[0] || { total: 0, count: 0 };
  const seatSummary = seatAgg[0] || {
    sold: 0,
    capacity: 0,
    limitedTicketTypes: 0,
  };

  successResponse(res, {
    byStatus: statsByStatus,
    byPaymentStatus: statsByPaymentStatus,
    byTicketType: ticketAgg,
    totalRevenue: totals.total,
    totalAttendees: totals.count,
    seatSummary: {
      sold: seatSummary.sold,
      capacity: seatSummary.capacity,
      available:
        seatSummary.limitedTicketTypes > 0
          ? Math.max(0, seatSummary.capacity - seatSummary.sold)
          : null,
      limitedTicketTypes: seatSummary.limitedTicketTypes,
    },
    waitlistCount,
  });
});

// ─── Coupons ──────────────────────────────────────────────────────────────────

export const listCoupons = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const coupons = await CouponCode.find({
    eventId: req.params.id,
    tenantId,
  })
    .populate("applicableTicketTypeIds", "name")
    .sort({ createdAt: -1 })
    .lean();

  successResponse(res, { coupons }, "Coupons retrieved");
});

export const createCoupon = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const coupon = await CouponCode.create({
    tenantId,
    eventId: req.params.id,
    code: req.body.code,
    description: req.body.description || "",
    discountType: req.body.discountType,
    discountValue: req.body.discountValue,
    maxDiscountAmount: req.body.maxDiscountAmount ?? null,
    minQuantity: req.body.minQuantity ?? 1,
    maxUses: req.body.maxUses ?? null,
    applicableTicketTypeIds: req.body.applicableTicketTypeIds || [],
    startsAt: req.body.startsAt || null,
    endsAt: req.body.endsAt || null,
    isActive: req.body.isActive ?? true,
  });

  successResponse(res, { coupon }, "Coupon created", 201);
});

export const updateCoupon = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const coupon = await CouponCode.findOneAndUpdate(
    {
      _id: req.params.couponId,
      eventId: req.params.id,
      tenantId,
    },
    { $set: req.body },
    { new: true, runValidators: true },
  );

  if (!coupon) throw ApiError.notFound("Coupon not found");

  successResponse(res, { coupon }, "Coupon updated");
});

/**
 * @desc    Get filtered registration report for an event
 * @route   GET /api/events/:id/registrations/report
 * @access  Private
 */
export const getRegistrationReport = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { from, to, status, ticketTypeId, groupBy = "day" } = req.query;

  const match = {
    eventId: new mongoose.Types.ObjectId(req.params.id),
    tenantId,
  };

  if (status) {
    match.status = status;
  }

  if (ticketTypeId) {
    match.ticketTypeId = new mongoose.Types.ObjectId(ticketTypeId);
  }

  if (from || to) {
    match.createdAt = {};
    if (from) {
      match.createdAt.$gte = new Date(from);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      match.createdAt.$lte = toDate;
    }
  }

  const dateFormat = groupBy === "week" ? "%G-W%V" : "%Y-%m-%d";

  const [summaryAgg, byStatusAgg, byTicketAgg, trendAgg] = await Promise.all([
    EventRegistration.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          registrations: { $sum: 1 },
          attendees: { $sum: "$quantity" },
          checkedIn: {
            $sum: {
              $cond: [{ $eq: ["$status", "checked_in"] }, "$quantity", 0],
            },
          },
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
    ]),
    EventRegistration.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          registrations: { $sum: 1 },
          attendees: { $sum: "$quantity" },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { attendees: -1 } },
    ]),
    EventRegistration.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$ticketTypeId",
          registrations: { $sum: 1 },
          attendees: { $sum: "$quantity" },
          revenue: { $sum: "$totalAmount" },
        },
      },
      {
        $lookup: {
          from: "tickettypes",
          localField: "_id",
          foreignField: "_id",
          as: "ticketType",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: "$ticketType", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          ticketTypeId: "$_id",
          name: "$ticketType.name",
          registrations: 1,
          attendees: 1,
          revenue: 1,
        },
      },
      { $sort: { attendees: -1 } },
    ]),
    EventRegistration.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: {
              format: dateFormat,
              date: "$createdAt",
            },
          },
          registrations: { $sum: 1 },
          attendees: { $sum: "$quantity" },
          checkedIn: {
            $sum: {
              $cond: [{ $eq: ["$status", "checked_in"] }, "$quantity", 0],
            },
          },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const summary = summaryAgg[0] || {
    registrations: 0,
    attendees: 0,
    checkedIn: 0,
    totalRevenue: 0,
  };

  const attendanceRate = summary.attendees
    ? Number(((summary.checkedIn / summary.attendees) * 100).toFixed(2))
    : 0;

  successResponse(res, {
    filters: {
      from: from || null,
      to: to || null,
      status: status || null,
      ticketTypeId: ticketTypeId || null,
      groupBy,
    },
    summary: {
      registrations: summary.registrations,
      attendees: summary.attendees,
      checkedIn: summary.checkedIn,
      attendanceRate,
      totalRevenue: summary.totalRevenue,
    },
    byStatus: byStatusAgg,
    byTicketType: byTicketAgg,
    trend: trendAgg,
  });
});

// ─── Domain APIs (Normalized Models) ─────────────────────────────────────────

/**
 * @desc    Get normalized event domain overview (attendees, orders, payments, check-ins)
 * @route   GET /api/events/:id/domain/overview
 * @access  Private/Admin
 */
export const getDomainOverview = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const [
    attendeeCount,
    orderStatusAgg,
    paymentStatusAgg,
    checkInCount,
    registrationStatusAgg,
  ] = await Promise.all([
    Attendee.countDocuments({ tenantId }),
    Order.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          eventId: new mongoose.Types.ObjectId(req.params.id),
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      {
        $lookup: {
          from: "orders",
          localField: "orderId",
          foreignField: "_id",
          as: "order",
        },
      },
      { $unwind: "$order" },
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          "order.eventId": new mongoose.Types.ObjectId(req.params.id),
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    CheckIn.countDocuments({
      tenantId,
      eventId: req.params.id,
    }),
    Registration.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          eventId: new mongoose.Types.ObjectId(req.params.id),
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  successResponse(res, {
    attendees: {
      totalTenantAttendees: attendeeCount,
    },
    orders: Object.fromEntries(
      orderStatusAgg.map((item) => [item._id, item.count]),
    ),
    payments: Object.fromEntries(
      paymentStatusAgg.map((item) => [item._id, item.count]),
    ),
    registrations: Object.fromEntries(
      registrationStatusAgg.map((item) => [item._id, item.count]),
    ),
    checkIns: {
      total: checkInCount,
    },
  });
});

/**
 * @desc    List normalized event orders
 * @route   GET /api/events/:id/orders
 * @access  Private/Admin
 */
export const listDomainOrders = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { page = 1, limit = 20, status, search } = req.query;
  const { page: p, limit: l, skip } = parsePagination(page, limit);

  const query = {
    tenantId,
    eventId: req.params.id,
  };

  if (status) {
    query.status = status;
  }

  if (search) {
    const pattern = { $regex: search, $options: "i" };
    const attendees = await Attendee.find({
      tenantId,
      $or: [
        { email: pattern },
        { firstName: pattern },
        { lastName: pattern },
        { company: pattern },
      ],
    })
      .select("_id")
      .lean();

    const attendeeIds = attendees.map((item) => item._id);
    if (!attendeeIds.length) {
      return paginatedResponse(res, [], {
        page: p,
        limit: l,
        totalPages: 0,
        totalDocs: 0,
      });
    }

    query.attendeeId = { $in: attendeeIds };
  }

  const [orders, totalDocs] = await Promise.all([
    Order.find(query)
      .populate("attendeeId", "firstName lastName email phone company")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
    Order.countDocuments(query),
  ]);

  const orderIds = orders.map((order) => order._id);
  const payments = await Payment.find({
    tenantId,
    orderId: { $in: orderIds },
  })
    .select("orderId amount currency status method transactionId paidAt")
    .lean();

  const paymentByOrderId = new Map(
    payments.map((payment) => [String(payment.orderId), payment]),
  );

  const data = orders.map((order) => ({
    ...order,
    payment: paymentByOrderId.get(String(order._id)) || null,
  }));

  paginatedResponse(res, data, {
    page: p,
    limit: l,
    totalPages: Math.ceil(totalDocs / l),
    totalDocs,
  });
});

/**
 * @desc    List normalized event payments
 * @route   GET /api/events/:id/payments
 * @access  Private/Admin
 */
export const listDomainPayments = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const { page = 1, limit = 20, status, method, search } = req.query;
  const { page: p, limit: l, skip } = parsePagination(page, limit);

  const paymentQuery = {
    tenantId,
  };

  if (status) {
    paymentQuery.status = status;
  }

  if (method) {
    paymentQuery.method = method;
  }

  const orderQuery = {
    tenantId,
    eventId: req.params.id,
  };

  if (search) {
    const pattern = { $regex: search, $options: "i" };
    const attendeeIds = await Attendee.find({
      tenantId,
      $or: [{ email: pattern }, { firstName: pattern }, { lastName: pattern }],
    })
      .select("_id")
      .lean();

    orderQuery.$or = [
      { orderNumber: pattern },
      { attendeeId: { $in: attendeeIds.map((item) => item._id) } },
    ];
  }

  const eventOrders = await Order.find(orderQuery).select("_id").lean();
  const orderIds = eventOrders.map((item) => item._id);

  if (!orderIds.length) {
    return paginatedResponse(res, [], {
      page: p,
      limit: l,
      totalPages: 0,
      totalDocs: 0,
    });
  }

  paymentQuery.orderId = { $in: orderIds };

  const [payments, totalDocs] = await Promise.all([
    Payment.find(paymentQuery)
      .populate({
        path: "orderId",
        select: "orderNumber status totalAmount currency attendeeId createdAt",
        populate: {
          path: "attendeeId",
          select: "firstName lastName email",
        },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
    Payment.countDocuments(paymentQuery),
  ]);

  paginatedResponse(res, payments, {
    page: p,
    limit: l,
    totalPages: Math.ceil(totalDocs / l),
    totalDocs,
  });
});

/**
 * @desc    List event check-in operations
 * @route   GET /api/events/:id/checkins
 * @access  Private/Admin
 */
export const listDomainCheckIns = asyncHandler(async (req, res) => {
  const tenantId = req.user.tenantId;
  await getOwnedEvent(req.params.id, tenantId);

  const {
    page = 1,
    limit = 20,
    channel,
    checkedInBy,
    from,
    to,
    search,
  } = req.query;
  const { page: p, limit: l, skip } = parsePagination(page, limit);

  const query = {
    tenantId,
    eventId: req.params.id,
  };

  if (channel) {
    query.channel = channel;
  }

  if (checkedInBy) {
    query.checkedInBy = checkedInBy;
  }

  if (from || to) {
    query.checkedInAt = {};
    if (from) {
      query.checkedInAt.$gte = new Date(from);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      query.checkedInAt.$lte = toDate;
    }
  }

  if (search) {
    const pattern = { $regex: search, $options: "i" };
    const legacyRegs = await EventRegistration.find({
      tenantId,
      eventId: req.params.id,
      $or: [
        { registrationNumber: pattern },
        { "attendee.email": pattern },
        { "attendee.firstName": pattern },
        { "attendee.lastName": pattern },
      ],
    })
      .select("_id")
      .lean();

    const legacyIds = legacyRegs.map((item) => item._id);
    if (!legacyIds.length) {
      return paginatedResponse(res, [], {
        page: p,
        limit: l,
        totalPages: 0,
        totalDocs: 0,
      });
    }

    query.legacyRegistrationId = { $in: legacyIds };
  }

  const [checkIns, totalDocs] = await Promise.all([
    CheckIn.find(query)
      .populate("checkedInBy", "name email")
      .populate(
        "legacyRegistrationId",
        "registrationNumber attendee status checkedInAt ticketTypeId",
      )
      .sort({ checkedInAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
    CheckIn.countDocuments(query),
  ]);

  paginatedResponse(res, checkIns, {
    page: p,
    limit: l,
    totalPages: Math.ceil(totalDocs / l),
    totalDocs,
  });
});
