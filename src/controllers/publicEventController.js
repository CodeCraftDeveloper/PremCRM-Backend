import Tenant from "../models/Tenant.js";
import Event from "../models/Event.js";
import TicketType from "../models/TicketType.js";
import EventRegistration from "../models/EventRegistration.js";
import Attendee from "../models/Attendee.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import Registration from "../models/Registration.js";
import Waitlist from "../models/Waitlist.js";
import CouponCode from "../models/CouponCode.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getActiveTenant = async (slug) => {
  const tenant = await Tenant.findOne({
    slug,
    isActive: true,
    "subscription.status": "active",
  }).lean();
  if (!tenant) throw ApiError.notFound("Tenant not found");
  return tenant;
};

const buildPublicTenantPayload = (tenant) => {
  if (!tenant) return null;

  const company = tenant.company || {};
  const publicEventLanding = tenant.settings?.publicEventLanding || {};

  return {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    companyName: company.name || tenant.name,
    referenceId: company.referenceId || null,
    logoUrl: `/tenants/${tenant._id}/company-logo/public`,
    publicEventLanding: {
      heroImageUrl: publicEventLanding.heroImageUrl || "",
      heroTagline: publicEventLanding.heroTagline || "",
      accentColor: publicEventLanding.accentColor || "#06b6d4",
    },
  };
};

const enrichTicketTypes = (ticketTypes) => {
  const now = new Date();
  return ticketTypes.map((tt) => ({
    ...tt,
    available: tt.capacity == null ? null : Math.max(0, tt.capacity - tt.sold),
    isSoldOut: tt.capacity != null && tt.sold >= tt.capacity,
    saleActive:
      (!tt.saleStartDate || tt.saleStartDate <= now) &&
      (!tt.saleEndDate || tt.saleEndDate >= now),
  }));
};

const sanitizeCustomFieldsForEvent = (eventFields = [], incoming = {}) => {
  if (!Array.isArray(eventFields) || !eventFields.length) {
    return {};
  }

  const input = incoming && typeof incoming === "object" ? incoming : {};
  const cleaned = {};

  for (const field of eventFields) {
    const key = String(field?.key || "").trim();
    if (!key) continue;

    const type = field?.type || "text";
    const rawValue = input[key];
    const hasValue =
      rawValue !== undefined &&
      rawValue !== null &&
      String(rawValue).trim() !== "";

    if (field?.required && !hasValue) {
      throw ApiError.badRequest(`${field.label || key} is required`);
    }

    if (!hasValue) continue;

    let value = rawValue;

    if (["text", "textarea", "select", "url", "date"].includes(type)) {
      value = String(rawValue).trim();
    }

    if (type === "number") {
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        throw ApiError.badRequest(
          `${field.label || key} must be a valid number`,
        );
      }
      value = numeric;
    }

    if (type === "url") {
      try {
        const parsedUrl = new URL(String(value));
        if (!parsedUrl.hostname) {
          throw new Error("Invalid URL");
        }
      } catch {
        throw ApiError.badRequest(`${field.label || key} must be a valid URL`);
      }
    }

    if (type === "date") {
      const dt = new Date(String(value));
      if (Number.isNaN(dt.getTime())) {
        throw ApiError.badRequest(`${field.label || key} must be a valid date`);
      }
    }

    const maxLength = Number(field?.maxLength || 0);
    if (maxLength > 0 && String(value).length > maxLength) {
      throw ApiError.badRequest(
        `${field.label || key} cannot exceed ${maxLength} characters`,
      );
    }

    if (
      type === "select" &&
      Array.isArray(field?.options) &&
      field.options.length
    ) {
      const allowed = new Set(field.options.map((option) => String(option)));
      if (!allowed.has(String(value))) {
        throw ApiError.badRequest(
          `${field.label || key} has an invalid option`,
        );
      }
    }

    cleaned[key] = value;
  }

  return cleaned;
};

const deriveOrderStatus = (paymentStatus) => {
  if (paymentStatus === "paid" || paymentStatus === "free") return "confirmed";
  if (paymentStatus === "refunded") return "refunded";
  if (paymentStatus === "failed") return "cancelled";
  return "pending";
};

const resolveCouponForRegistration = async ({
  tenantId,
  eventId,
  ticketTypeId,
  quantity,
  subtotalAmount,
  couponCode,
}) => {
  const normalizedCode = String(couponCode || "")
    .trim()
    .toUpperCase();
  if (!normalizedCode) {
    return {
      couponDoc: null,
      couponSnapshot: {},
      discountAmount: 0,
      totalAmount: subtotalAmount,
    };
  }

  const couponDoc = await CouponCode.findOne({
    tenantId,
    eventId,
    code: normalizedCode,
    isActive: true,
  });

  if (!couponDoc) {
    throw ApiError.badRequest("Coupon code is invalid or inactive");
  }

  const now = new Date();
  if (couponDoc.startsAt && couponDoc.startsAt > now) {
    throw ApiError.badRequest("Coupon is not active yet");
  }
  if (couponDoc.endsAt && couponDoc.endsAt < now) {
    throw ApiError.badRequest("Coupon has expired");
  }
  if (couponDoc.maxUses != null && couponDoc.usedCount >= couponDoc.maxUses) {
    throw ApiError.badRequest("Coupon usage limit has been reached");
  }
  if (quantity < (couponDoc.minQuantity || 1)) {
    throw ApiError.badRequest(
      `Coupon requires at least ${couponDoc.minQuantity} ticket(s)`,
    );
  }
  if (
    Array.isArray(couponDoc.applicableTicketTypeIds) &&
    couponDoc.applicableTicketTypeIds.length > 0 &&
    !couponDoc.applicableTicketTypeIds.some(
      (id) => String(id) === String(ticketTypeId),
    )
  ) {
    throw ApiError.badRequest("Coupon is not valid for this ticket type");
  }

  let discountAmount =
    couponDoc.discountType === "percentage"
      ? (subtotalAmount * couponDoc.discountValue) / 100
      : couponDoc.discountValue;

  if (couponDoc.maxDiscountAmount != null) {
    discountAmount = Math.min(discountAmount, couponDoc.maxDiscountAmount);
  }

  discountAmount = Math.max(0, Math.min(subtotalAmount, discountAmount));
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);

  return {
    couponDoc,
    couponSnapshot: {
      code: couponDoc.code,
      description: couponDoc.description,
      discountType: couponDoc.discountType,
      discountValue: couponDoc.discountValue,
      maxDiscountAmount: couponDoc.maxDiscountAmount,
    },
    discountAmount,
    totalAmount,
  };
};

const createDomainRegistrationArtifacts = async ({
  tenantId,
  eventId,
  ticketTypeId,
  attendee,
  quantity,
  subtotalAmount,
  discountAmount,
  totalAmount,
  currency,
  paymentStatus,
  notes,
  customFields,
  source,
  legacyRegistration,
  couponCodeId,
  couponCode,
  couponSnapshot,
}) => {
  const attendeeDoc = await Attendee.findOneAndUpdate(
    { tenantId, email: String(attendee.email).toLowerCase() },
    {
      $set: {
        firstName: attendee.firstName,
        lastName: attendee.lastName || "",
        phone: attendee.phone || "",
        company: attendee.company || "",
      },
      $setOnInsert: {
        tenantId,
        email: String(attendee.email).toLowerCase(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const order = await Order.create({
    tenantId,
    eventId,
    attendeeId: attendeeDoc._id,
    status: deriveOrderStatus(paymentStatus),
    subtotalAmount,
    discountAmount,
    totalAmount,
    currency,
    couponCodeId: couponCodeId || null,
    couponCode: couponCode || null,
    source,
    notes: notes || "",
  });

  const payment = await Payment.create({
    tenantId,
    eventId,
    orderId: order._id,
    amount: totalAmount,
    currency,
    status: paymentStatus,
    method: paymentStatus === "free" ? "free" : "other",
    paidAt:
      paymentStatus === "paid" || paymentStatus === "free" ? new Date() : null,
    metadata: {
      couponCode: couponCode || null,
      discountAmount,
      subtotalAmount,
    },
  });

  const registration = await Registration.create({
    tenantId,
    eventId,
    ticketTypeId,
    attendeeId: attendeeDoc._id,
    orderId: order._id,
    paymentId: payment._id,
    legacyRegistrationId: legacyRegistration._id,
    registrationNumber: legacyRegistration.registrationNumber,
    qrToken: legacyRegistration.qrToken,
    quantity,
    subtotalAmount,
    discountAmount,
    totalAmount,
    currency,
    status: legacyRegistration.status,
    paymentStatus,
    couponCodeId: couponCodeId || null,
    couponCode: couponCode || null,
    couponSnapshot: couponSnapshot || {},
    notes: notes || "",
    customFields,
    source,
  });

  return {
    attendeeId: attendeeDoc._id,
    orderId: order._id,
    paymentId: payment._id,
    registrationId: registration._id,
  };
};

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc  List upcoming/active events for a tenant
 * @route GET /api/public/events/:tenantSlug
 */
export const listPublicEvents = asyncHandler(async (req, res) => {
  const tenant = await getActiveTenant(req.params.tenantSlug);
  const now = new Date();

  const events = await Event.find({
    tenantId: tenant._id,
    status: { $in: ["upcoming", "active"] },
    endDate: { $gte: now },
  })
    .select("name description location startDate endDate status image tags")
    .sort({ startDate: 1 })
    .lean();

  successResponse(
    res,
    { events, tenant: buildPublicTenantPayload(tenant) },
    "Events retrieved",
  );
});

/**
 * @desc  Get event detail + ticket types
 * @route GET /api/public/events/:tenantSlug/:eventId
 */
export const getPublicEvent = asyncHandler(async (req, res) => {
  const tenant = await getActiveTenant(req.params.tenantSlug);

  const event = await Event.findOne({
    _id: req.params.eventId,
    tenantId: tenant._id,
  })
    .select(
      "name description location startDate endDate status image tags landing registrationFields",
    )
    .lean();

  if (!event) throw ApiError.notFound("Event not found");

  const ticketTypes = await TicketType.find({
    eventId: event._id,
    tenantId: tenant._id,
    status: { $ne: "paused" },
  })
    .select(
      "name description price currency capacity sold waitlistEnabled status saleStartDate saleEndDate perOrderMin perOrderMax",
    )
    .lean();

  successResponse(res, {
    event,
    ticketTypes: enrichTicketTypes(ticketTypes),
    tenant: buildPublicTenantPayload(tenant),
  });
});

/**
 * @desc  Register an attendee for an event
 * @route POST /api/public/events/:tenantSlug/:eventId/register
 */
export const publicRegisterForEvent = asyncHandler(async (req, res) => {
  const tenant = await getActiveTenant(req.params.tenantSlug);

  const event = await Event.findOne({
    _id: req.params.eventId,
    tenantId: tenant._id,
  }).lean();

  if (!event) throw ApiError.notFound("Event not found");
  if (event.status === "cancelled")
    throw ApiError.badRequest("This event has been cancelled");
  if (event.status === "completed")
    throw ApiError.badRequest("This event has already ended");

  const {
    ticketTypeId,
    quantity = 1,
    attendee,
    notes,
    customFields,
    couponCode,
  } = req.body;

  const normalizedCustomFields = sanitizeCustomFieldsForEvent(
    event.registrationFields,
    customFields,
  );

  // fetch with findById (not lean) so we can $inc in a separate call
  const ticketType = await TicketType.findOne({
    _id: ticketTypeId,
    eventId: event._id,
    tenantId: tenant._id,
  });

  if (!ticketType) throw ApiError.notFound("Ticket type not found");
  if (ticketType.status === "paused")
    throw ApiError.badRequest("Ticket sales are paused for this type");

  const now = new Date();
  if (ticketType.saleStartDate && ticketType.saleStartDate > now)
    throw ApiError.badRequest("Ticket sales have not started yet");
  if (ticketType.saleEndDate && ticketType.saleEndDate < now)
    throw ApiError.badRequest("Ticket sales have ended");

  const qty = parseInt(quantity, 10);
  if (qty < ticketType.perOrderMin)
    throw ApiError.badRequest(
      `Minimum ${ticketType.perOrderMin} ticket(s) per order`,
    );
  if (qty > ticketType.perOrderMax)
    throw ApiError.badRequest(
      `Maximum ${ticketType.perOrderMax} ticket(s) per order`,
    );

  if (ticketType.capacity != null) {
    const remaining = ticketType.capacity - ticketType.sold;
    if (remaining < qty)
      throw ApiError.badRequest(
        remaining === 0
          ? "Tickets are sold out"
          : `Only ${remaining} ticket(s) remaining`,
      );
  }

  const subtotalAmount = ticketType.price * qty;
  const { couponDoc, couponSnapshot, discountAmount, totalAmount } =
    await resolveCouponForRegistration({
      tenantId: tenant._id,
      eventId: event._id,
      ticketTypeId: ticketType._id,
      quantity: qty,
      subtotalAmount,
      couponCode,
    });
  const paymentStatus = totalAmount === 0 ? "free" : "pending";

  const registration = await EventRegistration.create({
    tenantId: tenant._id,
    eventId: event._id,
    ticketTypeId: ticketType._id,
    attendee,
    quantity: qty,
    subtotalAmount,
    discountAmount,
    totalAmount,
    currency: ticketType.currency,
    status: "confirmed",
    paymentStatus,
    couponCodeId: couponDoc?._id || null,
    couponCode: couponDoc?.code || null,
    couponSnapshot,
    notes: notes || "",
    customFields: normalizedCustomFields,
    source: "web",
    ipAddress: req.ip,
  });

  const domainRefs = await createDomainRegistrationArtifacts({
    tenantId: tenant._id,
    eventId: event._id,
    ticketTypeId: ticketType._id,
    attendee,
    quantity: qty,
    subtotalAmount,
    discountAmount,
    totalAmount,
    currency: ticketType.currency,
    paymentStatus,
    notes,
    customFields: normalizedCustomFields,
    source: "web",
    legacyRegistration: registration,
    couponCodeId: couponDoc?._id || null,
    couponCode: couponDoc?.code || null,
    couponSnapshot,
  });

  if (couponDoc?._id) {
    await CouponCode.findByIdAndUpdate(couponDoc._id, {
      $inc: { usedCount: 1 },
    });
  }

  // Increment sold counter atomically
  await TicketType.findByIdAndUpdate(ticketType._id, { $inc: { sold: qty } });

  // Auto mark sold_out when capacity reached
  if (
    ticketType.capacity != null &&
    ticketType.sold + qty >= ticketType.capacity
  ) {
    await TicketType.findByIdAndUpdate(ticketType._id, {
      status: "sold_out",
    });
  }

  const regObj = registration.toObject();
  delete regObj.ipAddress;
  regObj.domainRefs = domainRefs;

  successResponse(
    res,
    { registration: regObj },
    "Registration successful",
    201,
  );
});

/**
 * @desc  Fetch registration by QR token (attendee confirmation / check-in lookup)
 * @route GET /api/public/registrations/:qrToken
 */
export const getRegistrationByQrToken = asyncHandler(async (req, res) => {
  const registration = await EventRegistration.findOne({
    qrToken: req.params.qrToken,
  })
    .populate("eventId", "name location startDate endDate")
    .populate("ticketTypeId", "name price currency")
    .lean();

  if (!registration) throw ApiError.notFound("Registration not found");

  const tenant = await Tenant.findById(registration.tenantId)
    .select("name slug company settings")
    .lean();

  // Strip sensitive ip field
  delete registration.ipAddress;

  successResponse(res, {
    registration,
    tenant: buildPublicTenantPayload(tenant),
  });
});

/**
 * @desc  Join waitlist for a sold-out ticket type
 * @route POST /api/public/events/:tenantSlug/:eventId/ticket-types/:ticketTypeId/waitlist
 */
export const joinWaitlist = asyncHandler(async (req, res) => {
  const tenant = await getActiveTenant(req.params.tenantSlug);

  const ticketType = await TicketType.findOne({
    _id: req.params.ticketTypeId,
    eventId: req.params.eventId,
    tenantId: tenant._id,
  }).lean();

  if (!ticketType) throw ApiError.notFound("Ticket type not found");
  if (!ticketType.waitlistEnabled)
    throw ApiError.badRequest("Waitlist is not enabled for this ticket type");

  const { attendee } = req.body;

  // Prevent duplicate active waitlist entries
  const existing = await Waitlist.findOne({
    "attendee.email": attendee.email.toLowerCase(),
    eventId: req.params.eventId,
    ticketTypeId: req.params.ticketTypeId,
    status: { $in: ["waiting", "notified"] },
  }).lean();

  if (existing)
    throw ApiError.conflict(
      "You are already on the waitlist for this ticket type",
    );

  // Assign sequential position
  const last = await Waitlist.findOne({
    eventId: req.params.eventId,
    ticketTypeId: req.params.ticketTypeId,
  })
    .sort({ position: -1 })
    .select("position")
    .lean();

  const position = (last?.position ?? 0) + 1;

  const entry = await Waitlist.create({
    tenantId: tenant._id,
    eventId: req.params.eventId,
    ticketTypeId: req.params.ticketTypeId,
    attendee,
    position,
  });

  successResponse(
    res,
    { waitlistEntry: entry, position },
    "You have been added to the waitlist",
    201,
  );
});
