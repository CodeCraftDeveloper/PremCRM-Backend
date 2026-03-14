import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let app;
let request;

let Tenant;
let User;
let Event;
let TicketType;
let CouponCode;
let EventRegistration;
let Registration;
let Order;
let Payment;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function createTenantCtx(slug) {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan: "pro",
    subscription: { status: "active" },
  });

  const user = await User.create({
    name: `Admin ${slug}`,
    email: `admin@${slug}.com`,
    password: "Password123!",
    role: "admin",
    tenantId: tenant._id,
    approvalStatus: "approved",
    isActive: true,
  });

  const token = makeToken(user._id, tenant._id, "admin");
  return { tenant, user, token };
}

async function createEventAndTicket(tenantId, userId, overrides = {}) {
  const now = new Date();
  const event = await Event.create({
    tenantId,
    name: "Lifecycle Test Event",
    startDate: new Date(now.getTime() - 60 * 60 * 1000),
    endDate: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdBy: userId,
    ...overrides.event,
  });

  const ticketType = await TicketType.create({
    tenantId,
    eventId: event._id,
    name: "General Admission",
    price: 1000,
    currency: "INR",
    capacity: 5,
    status: "active",
    perOrderMin: 1,
    perOrderMax: 5,
    ...overrides.ticketType,
  });

  return { event, ticketType };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const appModule = await import("../../app.js");
  app = appModule.default;

  const supertest = await import("supertest");
  request = supertest.default(app);

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  Event = (await import("../../src/models/Event.js")).default;
  TicketType = (await import("../../src/models/TicketType.js")).default;
  CouponCode = (await import("../../src/models/CouponCode.js")).default;
  EventRegistration = (await import("../../src/models/EventRegistration.js"))
    .default;
  Registration = (await import("../../src/models/Registration.js")).default;
  Order = (await import("../../src/models/Order.js")).default;
  Payment = (await import("../../src/models/Payment.js")).default;
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

describe("Event registration lifecycle", () => {
  it("applies coupon discounts and increments coupon usage", async () => {
    const ctx = await createTenantCtx("coupon-flow");
    const { event, ticketType } = await createEventAndTicket(
      ctx.tenant._id,
      ctx.user._id,
    );

    const createCouponRes = await request
      .post(`/api/v1/events/${event._id}/coupons`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        code: "EARLY20",
        discountType: "percentage",
        discountValue: 20,
        minQuantity: 1,
        isActive: true,
      });

    expect(createCouponRes.status).toBe(201);

    const registerRes = await request
      .post(`/api/v1/public/events/${ctx.tenant.slug}/${event._id}/register`)
      .send({
        ticketTypeId: ticketType._id.toString(),
        quantity: 2,
        attendee: {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane+coupon@test.com",
          phone: "+919999999999",
        },
        couponCode: "EARLY20",
      });

    expect(registerRes.status).toBe(201);

    const registrationId = registerRes.body?.data?.registration?._id;
    expect(registrationId).toBeTruthy();

    const reg = await EventRegistration.findById(registrationId).lean();
    expect(reg).toBeTruthy();
    expect(reg.subtotalAmount).toBe(2000);
    expect(reg.discountAmount).toBe(400);
    expect(reg.totalAmount).toBe(1600);
    expect(reg.couponCode).toBe("EARLY20");

    const coupon = await CouponCode.findOne({
      tenantId: ctx.tenant._id,
      eventId: event._id,
      code: "EARLY20",
    }).lean();
    expect(coupon).toBeTruthy();
    expect(coupon.usedCount).toBe(1);
  });

  it("refunds a registration and releases sold seat inventory", async () => {
    const ctx = await createTenantCtx("refund-flow");
    const { event, ticketType } = await createEventAndTicket(
      ctx.tenant._id,
      ctx.user._id,
      {
        ticketType: { capacity: 3 },
      },
    );

    const registerRes = await request
      .post(`/api/v1/public/events/${ctx.tenant.slug}/${event._id}/register`)
      .send({
        ticketTypeId: ticketType._id.toString(),
        quantity: 2,
        attendee: {
          firstName: "Rahul",
          lastName: "Sharma",
          email: "rahul+refund@test.com",
          phone: "+918888888888",
        },
      });

    expect(registerRes.status).toBe(201);

    const registrationId = registerRes.body?.data?.registration?._id;
    const createdReg = await EventRegistration.findById(registrationId).lean();
    expect(createdReg).toBeTruthy();

    const soldBeforeRefund = await TicketType.findById(ticketType._id)
      .select("sold")
      .lean();
    expect(soldBeforeRefund.sold).toBe(2);

    const refundRes = await request
      .patch(
        `/api/v1/events/${event._id}/registrations/${registrationId}/refund`,
      )
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ reason: "Attendee requested cancellation" });

    expect(refundRes.status).toBe(200);

    const legacyReg = await EventRegistration.findById(registrationId).lean();
    expect(legacyReg.status).toBe("cancelled");
    expect(legacyReg.paymentStatus).toBe("refunded");
    expect(legacyReg.cancelledAt).toBeTruthy();
    expect(legacyReg.refundedAt).toBeTruthy();

    const ticketAfterRefund = await TicketType.findById(ticketType._id)
      .select("sold status")
      .lean();
    expect(ticketAfterRefund.sold).toBe(0);
    expect(ticketAfterRefund.status).toBe("active");

    const domainReg = await Registration.findOne({
      legacyRegistrationId: registrationId,
      eventId: event._id,
      tenantId: ctx.tenant._id,
    }).lean();
    expect(domainReg).toBeTruthy();
    expect(domainReg.status).toBe("cancelled");
    expect(domainReg.paymentStatus).toBe("refunded");

    const order = await Order.findById(domainReg.orderId).lean();
    expect(order.status).toBe("refunded");
    expect(order.refundedAt).toBeTruthy();

    const payment = await Payment.findById(domainReg.paymentId).lean();
    expect(payment.status).toBe("refunded");
    expect(payment.refundedAt).toBeTruthy();
  });
});
