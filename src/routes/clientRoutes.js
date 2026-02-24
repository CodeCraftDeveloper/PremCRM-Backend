import express from "express";
import { body, query } from "express-validator";
import {
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  uploadVisitingCard,
  getPendingFollowUps,
  getClientStats,
  bulkAssignClients,
} from "../controllers/clientController.js";
import {
  getRemarks,
  createRemark,
  getClientTimeline,
} from "../controllers/remarkController.js";
import { protect, adminOnly, marketingOrAdmin } from "../middlewares/auth.js";
import {
  uploadVisitingCard as uploadMiddleware,
  handleUploadError,
} from "../middlewares/upload.js";
import { uploadLimiter } from "../middlewares/rateLimiter.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/clients/stats
 * @desc    Get client statistics
 * @access  Private
 */
router.get("/stats", getClientStats);

/**
 * @route   GET /api/clients/follow-ups/pending
 * @desc    Get pending follow-ups
 * @access  Private
 */
router.get("/follow-ups/pending", getPendingFollowUps);

/**
 * @route   PUT /api/clients/bulk-assign
 * @desc    Bulk assign clients
 * @access  Private/Admin
 */
router.put(
  "/bulk-assign",
  adminOnly,
  [
    body("clientIds")
      .isArray({ min: 1 })
      .withMessage("Client IDs must be a non-empty array"),
    body("marketingPersonId")
      .notEmpty()
      .withMessage("Marketing person ID is required")
      .isMongoId()
      .withMessage("Invalid marketing person ID"),
    validate,
  ],
  bulkAssignClients,
);

/**
 * @route   GET /api/clients
 * @desc    Get all clients
 * @access  Private
 */
router.get("/", [...commonValidations.pagination(), validate], getClients);

/**
 * @route   GET /api/clients/:id
 * @desc    Get single client
 * @access  Private
 */
router.get("/:id", [commonValidations.mongoId("id"), validate], getClient);

/**
 * @route   POST /api/clients
 * @desc    Create client
 * @access  Private
 */
router.post(
  "/",
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Client name is required")
      .isLength({ max: 100 })
      .withMessage("Name cannot exceed 100 characters"),
    body("companyName")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Company name cannot exceed 200 characters"),
    body("email").optional().isEmail().withMessage("Invalid email format"),
    body("phone").optional().trim(),
    body("event")
      .notEmpty()
      .withMessage("Event is required")
      .isMongoId()
      .withMessage("Invalid event ID"),
    body("marketingPerson")
      .optional()
      .isMongoId()
      .withMessage("Invalid marketing person ID"),
    body("followUpStatus")
      .optional()
      .isIn([
        "new",
        "contacted",
        "interested",
        "negotiation",
        "converted",
        "lost",
      ])
      .withMessage("Invalid follow-up status"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    body("nextFollowUpDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),
    body("source")
      .optional()
      .isIn([
        "event",
        "referral",
        "website",
        "cold_call",
        "email",
        "social_media",
        "other",
      ])
      .withMessage("Invalid source"),
    body("estimatedValue")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Estimated value must be a positive number"),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    validate,
  ],
  createClient,
);

/**
 * @route   PUT /api/clients/:id
 * @desc    Update client
 * @access  Private
 */
router.put(
  "/:id",
  [
    commonValidations.mongoId("id"),
    body("name")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Name cannot exceed 100 characters"),
    body("email").optional().isEmail().withMessage("Invalid email format"),
    body("followUpStatus")
      .optional()
      .isIn([
        "new",
        "contacted",
        "interested",
        "negotiation",
        "converted",
        "lost",
      ])
      .withMessage("Invalid follow-up status"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    validate,
  ],
  updateClient,
);

/**
 * @route   DELETE /api/clients/:id
 * @desc    Delete client
 * @access  Private
 */
router.delete(
  "/:id",
  [commonValidations.mongoId("id"), validate],
  deleteClient,
);

/**
 * @route   POST /api/clients/:id/visiting-card
 * @desc    Upload visiting card
 * @access  Private
 */
router.post(
  "/:id/visiting-card",
  uploadLimiter,
  [commonValidations.mongoId("id"), validate],
  uploadMiddleware,
  handleUploadError,
  uploadVisitingCard,
);

/**
 * @route   GET /api/clients/:clientId/remarks
 * @desc    Get remarks for a client
 * @access  Private
 */
router.get(
  "/:clientId/remarks",
  [commonValidations.mongoId("clientId", "params"), validate],
  getRemarks,
);

/**
 * @route   POST /api/clients/:clientId/remarks
 * @desc    Create a remark for a client
 * @access  Private
 */
router.post(
  "/:clientId/remarks",
  [
    commonValidations.mongoId("clientId", "params"),
    body("content")
      .trim()
      .notEmpty()
      .withMessage("Remark content is required")
      .isLength({ max: 2000 })
      .withMessage("Remark cannot exceed 2000 characters"),
    body("type")
      .optional()
      .isIn(["note", "call", "email", "meeting", "follow_up"])
      .withMessage("Invalid remark type"),
    body("isInternal")
      .optional()
      .isBoolean()
      .withMessage("isInternal must be boolean"),
    validate,
  ],
  createRemark,
);

/**
 * @route   GET /api/clients/:clientId/timeline
 * @desc    Get remark timeline for a client
 * @access  Private
 */
router.get(
  "/:clientId/timeline",
  [commonValidations.mongoId("clientId", "params"), validate],
  getClientTimeline,
);

export default router;
