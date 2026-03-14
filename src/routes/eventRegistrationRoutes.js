import express from "express";
import { body, param, query } from "express-validator";
import {
  listTicketTypes,
  createTicketType,
  updateTicketType,
  deleteTicketType,
  listRegistrations,
  getRegistration,
  updateRegistrationStatus,
  refundRegistration,
  updateRegistrationAttendee,
  checkInAttendee,
  listWaitlist,
  updateWaitlistStatus,
  getRegistrationStats,
  getRegistrationReport,
  getDomainOverview,
  listDomainOrders,
  listDomainPayments,
  listDomainCheckIns,
  listCoupons,
  createCoupon,
  updateCoupon,
} from "../controllers/eventRegistrationController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router({ mergeParams: true });

// All routes require authentication
router.use(protect);

// ─── Ticket Types ─────────────────────────────────────────────────────────────

router
  .route("/:id/ticket-types")
  /**
   * @route  GET /api/events/:id/ticket-types
   * @desc   List ticket types for an event
   * @access Private
   */
  .get([commonValidations.mongoId("id"), validate], listTicketTypes)
  /**
   * @route  POST /api/events/:id/ticket-types
   * @desc   Create a ticket type
   * @access Private/Admin
   */
  .post(
    adminOnly,
    [
      commonValidations.mongoId("id"),
      body("name")
        .trim()
        .notEmpty()
        .withMessage("Name is required")
        .isLength({ max: 100 }),
      body("description").optional().trim().isLength({ max: 500 }),
      body("price")
        .notEmpty()
        .withMessage("Price is required")
        .isFloat({ min: 0 })
        .withMessage("Price must be a non-negative number"),
      body("currency").optional().trim().isLength({ min: 3, max: 3 }),
      body("capacity")
        .optional({ nullable: true })
        .isInt({ min: 1 })
        .withMessage("Capacity must be a positive integer"),
      body("waitlistEnabled").optional().isBoolean(),
      body("saleStartDate").optional({ nullable: true }).isISO8601(),
      body("saleEndDate").optional({ nullable: true }).isISO8601(),
      body("perOrderMin").optional().isInt({ min: 1 }),
      body("perOrderMax").optional().isInt({ min: 1 }),
      validate,
    ],
    createTicketType,
  );

router
  .route("/:id/ticket-types/:ttId")
  /**
   * @route  PUT /api/events/:id/ticket-types/:ttId
   * @access Private/Admin
   */
  .put(
    adminOnly,
    [
      commonValidations.mongoId("id"),
      param("ttId").isMongoId().withMessage("Invalid ticket type ID"),
      body("name").optional().trim().isLength({ max: 100 }),
      body("description").optional().trim().isLength({ max: 500 }),
      body("price").optional().isFloat({ min: 0 }),
      body("capacity").optional({ nullable: true }).isInt({ min: 1 }),
      body("waitlistEnabled").optional().isBoolean(),
      body("status")
        .optional()
        .isIn(["active", "paused", "sold_out"])
        .withMessage("Invalid status"),
      body("saleStartDate").optional({ nullable: true }).isISO8601(),
      body("saleEndDate").optional({ nullable: true }).isISO8601(),
      body("perOrderMin").optional().isInt({ min: 1 }),
      body("perOrderMax").optional().isInt({ min: 1 }),
      validate,
    ],
    updateTicketType,
  )
  /**
   * @route  DELETE /api/events/:id/ticket-types/:ttId
   * @access Private/Admin
   */
  .delete(
    adminOnly,
    [
      commonValidations.mongoId("id"),
      param("ttId").isMongoId().withMessage("Invalid ticket type ID"),
      validate,
    ],
    deleteTicketType,
  );

// ─── Registrations ────────────────────────────────────────────────────────────

/**
 * @route  GET /api/events/:id/registrations/stats
 * @access Private
 */
router.get(
  "/:id/registrations/stats",
  [commonValidations.mongoId("id"), validate],
  getRegistrationStats,
);

/**
 * @route  GET /api/events/:id/registrations/report
 * @access Private
 */
router.get(
  "/:id/registrations/report",
  [
    commonValidations.mongoId("id"),
    query("from").optional().isISO8601().withMessage("from must be ISO date"),
    query("to").optional().isISO8601().withMessage("to must be ISO date"),
    query("status")
      .optional()
      .isIn(["pending", "confirmed", "cancelled", "checked_in", "no_show"]),
    query("ticketTypeId").optional().isMongoId(),
    query("groupBy").optional().isIn(["day", "week"]),
    validate,
  ],
  getRegistrationReport,
);

/**
 * @route  GET /api/events/:id/domain/overview
 * @access Private/Admin
 */
router.get(
  "/:id/domain/overview",
  adminOnly,
  [commonValidations.mongoId("id"), validate],
  getDomainOverview,
);

/**
 * @route  GET /api/events/:id/orders
 * @access Private/Admin
 */
router.get(
  "/:id/orders",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    ...commonValidations.pagination(),
    query("status")
      .optional()
      .isIn(["draft", "pending", "confirmed", "cancelled", "refunded"]),
    query("search").optional().trim().isLength({ max: 100 }),
    validate,
  ],
  listDomainOrders,
);

/**
 * @route  GET /api/events/:id/payments
 * @access Private/Admin
 */
router.get(
  "/:id/payments",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    ...commonValidations.pagination(),
    query("status")
      .optional()
      .isIn(["free", "pending", "paid", "refunded", "failed"]),
    query("method")
      .optional()
      .isIn(["free", "card", "upi", "bank_transfer", "cash", "other"]),
    query("search").optional().trim().isLength({ max: 100 }),
    validate,
  ],
  listDomainPayments,
);

/**
 * @route  GET /api/events/:id/checkins
 * @access Private/Admin
 */
router.get(
  "/:id/checkins",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    ...commonValidations.pagination(),
    query("channel").optional().isIn(["qr", "manual", "api"]),
    query("checkedInBy").optional().isMongoId(),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
    query("search").optional().trim().isLength({ max: 100 }),
    validate,
  ],
  listDomainCheckIns,
);

/**
 * @route  GET /api/events/:id/registrations
 * @access Private
 */
router.get(
  "/:id/registrations",
  [
    commonValidations.mongoId("id"),
    ...commonValidations.pagination(),
    query("status")
      .optional()
      .isIn(["pending", "confirmed", "cancelled", "checked_in", "no_show"]),
    query("ticketTypeId").optional().isMongoId(),
    query("search").optional().trim().isLength({ max: 100 }),
    validate,
  ],
  listRegistrations,
);

/**
 * @route  GET /api/events/:id/registrations/:regId
 * @access Private
 */
router.get(
  "/:id/registrations/:regId",
  [
    commonValidations.mongoId("id"),
    param("regId").isMongoId().withMessage("Invalid registration ID"),
    validate,
  ],
  getRegistration,
);

/**
 * @route  PATCH /api/events/:id/registrations/:regId/status
 * @access Private/Admin
 */
router.patch(
  "/:id/registrations/:regId/status",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    param("regId").isMongoId().withMessage("Invalid registration ID"),
    body("status")
      .notEmpty()
      .withMessage("Status is required")
      .isIn(["pending", "confirmed", "cancelled", "no_show"])
      .withMessage("Invalid status"),
    body("reason").optional().trim().isLength({ max: 500 }),
    validate,
  ],
  updateRegistrationStatus,
);

router.patch(
  "/:id/registrations/:regId/refund",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    param("regId").isMongoId().withMessage("Invalid registration ID"),
    body("reason").optional().trim().isLength({ max: 500 }),
    body("refundAmount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Refund amount must be a non-negative number"),
    validate,
  ],
  refundRegistration,
);

/**
 * @route  PATCH /api/events/:id/registrations/:regId/attendee
 * @access Private/Admin
 */
router.patch(
  "/:id/registrations/:regId/attendee",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    param("regId").isMongoId().withMessage("Invalid registration ID"),
    body("firstName")
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("First name must be 1-50 characters"),
    body("lastName")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Last name must be at most 50 characters"),
    body("email")
      .optional()
      .trim()
      .isEmail()
      .withMessage("Please provide a valid email"),
    body("phone")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Phone must be at most 20 characters"),
    body("company")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Company must be at most 100 characters"),
    body("notes")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Notes must be at most 2000 characters"),
    validate,
  ],
  updateRegistrationAttendee,
);

// ─── Check-in ─────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/events/:id/checkin
 * @desc   Check in an attendee by QR token
 * @access Private
 */
router.post(
  "/:id/checkin",
  [
    commonValidations.mongoId("id"),
    body("qrToken")
      .trim()
      .notEmpty()
      .withMessage("QR token or registration number is required")
      .custom((value) => {
        const trimmed = String(value || "").trim();
        const isQrToken = /^[0-9a-f]{48}$/i.test(trimmed);
        const isRegistrationNumber = /^REG-[A-Z0-9-]{6,}$/i.test(trimmed);
        if (!isQrToken && !isRegistrationNumber) {
          throw new Error("Provide a valid QR token or registration number");
        }
        return true;
      }),
    validate,
  ],
  checkInAttendee,
);

// ─── Waitlist ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/events/:id/waitlist
 * @access Private
 */
router.get(
  "/:id/waitlist",
  [
    commonValidations.mongoId("id"),
    query("ticketTypeId").optional().isMongoId(),
    query("status")
      .optional()
      .isIn(["waiting", "notified", "converted", "expired"]),
    validate,
  ],
  listWaitlist,
);

/**
 * @route  PATCH /api/events/:id/waitlist/:entryId/status
 * @access Private/Admin
 */
router.patch(
  "/:id/waitlist/:entryId/status",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    param("entryId").isMongoId().withMessage("Invalid waitlist entry ID"),
    body("status")
      .notEmpty()
      .isIn(["notified", "converted", "expired"])
      .withMessage("Status must be notified, converted, or expired"),
    validate,
  ],
  updateWaitlistStatus,
);

// ─── Coupons ──────────────────────────────────────────────────────────────────

router
  .route("/:id/coupons")
  .get(adminOnly, [commonValidations.mongoId("id"), validate], listCoupons)
  .post(
    adminOnly,
    [
      commonValidations.mongoId("id"),
      body("code")
        .trim()
        .notEmpty()
        .withMessage("Coupon code is required")
        .isLength({ max: 32 }),
      body("description").optional().trim().isLength({ max: 240 }),
      body("discountType")
        .isIn(["percentage", "fixed"])
        .withMessage("Discount type must be percentage or fixed"),
      body("discountValue")
        .isFloat({ min: 0 })
        .withMessage("Discount value must be a non-negative number"),
      body("maxDiscountAmount")
        .optional({ nullable: true })
        .isFloat({ min: 0 }),
      body("minQuantity").optional().isInt({ min: 1 }),
      body("maxUses").optional({ nullable: true }).isInt({ min: 1 }),
      body("applicableTicketTypeIds").optional().isArray(),
      body("applicableTicketTypeIds.*")
        .optional()
        .isMongoId()
        .withMessage("Applicable ticket IDs must be valid"),
      body("startsAt").optional({ nullable: true }).isISO8601(),
      body("endsAt").optional({ nullable: true }).isISO8601(),
      body("isActive").optional().isBoolean(),
      validate,
    ],
    createCoupon,
  );

router.patch(
  "/:id/coupons/:couponId",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    param("couponId").isMongoId().withMessage("Invalid coupon ID"),
    body("code").optional().trim().isLength({ min: 1, max: 32 }),
    body("description").optional().trim().isLength({ max: 240 }),
    body("discountType").optional().isIn(["percentage", "fixed"]),
    body("discountValue").optional().isFloat({ min: 0 }),
    body("maxDiscountAmount").optional({ nullable: true }).isFloat({ min: 0 }),
    body("minQuantity").optional().isInt({ min: 1 }),
    body("maxUses").optional({ nullable: true }).isInt({ min: 1 }),
    body("applicableTicketTypeIds").optional().isArray(),
    body("applicableTicketTypeIds.*").optional().isMongoId(),
    body("startsAt").optional({ nullable: true }).isISO8601(),
    body("endsAt").optional({ nullable: true }).isISO8601(),
    body("isActive").optional().isBoolean(),
    validate,
  ],
  updateCoupon,
);

export default router;
