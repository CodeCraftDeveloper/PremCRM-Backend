import express from "express";
import { body, param } from "express-validator";
import {
  listPublicEvents,
  getPublicEvent,
  publicRegisterForEvent,
  getRegistrationByQrToken,
  joinWaitlist,
} from "../controllers/publicEventController.js";
import { validate } from "../utils/validators.js";
import { publicLeadLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

// Apply per-IP rate limit to all public event routes
router.use(publicLeadLimiter);

/**
 * @route  GET /api/public/events/:tenantSlug
 * @desc   List upcoming/active events for a tenant
 * @access Public
 */
router.get(
  "/events/:tenantSlug",
  [
    param("tenantSlug")
      .trim()
      .notEmpty()
      .withMessage("Tenant slug is required"),
    validate,
  ],
  listPublicEvents,
);

/**
 * @route  GET /api/public/events/:tenantSlug/:eventId
 * @desc   Get event detail + ticket types
 * @access Public
 */
router.get(
  "/events/:tenantSlug/:eventId",
  [
    param("tenantSlug").trim().notEmpty(),
    param("eventId").isMongoId().withMessage("Invalid event ID"),
    validate,
  ],
  getPublicEvent,
);

/**
 * @route  POST /api/public/events/:tenantSlug/:eventId/register
 * @desc   Submit an event registration
 * @access Public
 */
router.post(
  "/events/:tenantSlug/:eventId/register",
  [
    param("tenantSlug").trim().notEmpty(),
    param("eventId").isMongoId().withMessage("Invalid event ID"),
    body("ticketTypeId")
      .isMongoId()
      .withMessage("Valid ticket type ID is required"),
    body("quantity")
      .optional()
      .isInt({ min: 1, max: 20 })
      .withMessage("Quantity must be between 1 and 20"),
    body("attendee.firstName")
      .trim()
      .notEmpty()
      .withMessage("First name is required")
      .isLength({ max: 50 })
      .withMessage("First name cannot exceed 50 characters"),
    body("attendee.lastName")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Last name cannot exceed 50 characters"),
    body("attendee.email")
      .trim()
      .notEmpty()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Please provide a valid email")
      .normalizeEmail(),
    body("attendee.phone")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Phone cannot exceed 20 characters"),
    body("attendee.company")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Company cannot exceed 100 characters"),
    body("notes")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Notes cannot exceed 2000 characters"),
    body("customFields")
      .optional()
      .isObject()
      .withMessage("Custom fields must be an object"),
    body("couponCode")
      .optional()
      .trim()
      .isLength({ max: 32 })
      .withMessage("Coupon code cannot exceed 32 characters"),
    validate,
  ],
  publicRegisterForEvent,
);

/**
 * @route  GET /api/public/registrations/:qrToken
 * @desc   Get registration by QR token (attendee confirmation page)
 * @access Public
 */
router.get(
  "/registrations/:qrToken",
  [
    param("qrToken")
      .trim()
      .notEmpty()
      .isHexadecimal()
      .isLength({ min: 48, max: 48 })
      .withMessage("Invalid QR token"),
    validate,
  ],
  getRegistrationByQrToken,
);

/**
 * @route  POST /api/public/events/:tenantSlug/:eventId/ticket-types/:ticketTypeId/waitlist
 * @desc   Join the waitlist for a ticket type
 * @access Public
 */
router.post(
  "/events/:tenantSlug/:eventId/ticket-types/:ticketTypeId/waitlist",
  [
    param("tenantSlug").trim().notEmpty(),
    param("eventId").isMongoId().withMessage("Invalid event ID"),
    param("ticketTypeId").isMongoId().withMessage("Invalid ticket type ID"),
    body("attendee.firstName")
      .trim()
      .notEmpty()
      .withMessage("First name is required")
      .isLength({ max: 50 }),
    body("attendee.lastName").optional().trim().isLength({ max: 50 }),
    body("attendee.email")
      .trim()
      .notEmpty()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Please provide a valid email")
      .normalizeEmail(),
    body("attendee.phone").optional().trim().isLength({ max: 20 }),
    validate,
  ],
  joinWaitlist,
);

export default router;
