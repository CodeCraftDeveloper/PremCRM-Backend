import express from "express";
import { body, param, query } from "express-validator";
import {
  getTickets,
  getTicketDetail,
  createTicket,
  updateTicket,
  updateTicketStatus,
  assignTicket,
  deleteTicket,
  restoreTicket,
  getTicketStats,
  getTicketFollowUps,
  bulkUpdateStatus,
  bulkAssignTickets,
  getTicketsByEntity,
} from "../controllers/ticketController.js";
import {
  getTicketRemarks,
  createTicketRemark,
  updateTicketRemark,
  deleteTicketRemark,
} from "../controllers/ticketRemarkController.js";
import { protect, authorize } from "../middlewares/auth.js";
import { validate } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

// ═══════════════════════════════════════════════════════════
// TICKET CRUD
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/tickets/stats
 * @desc    Get ticket statistics
 * @access  Private
 */
router.get("/stats", getTicketStats);

/**
 * @route   GET /api/tickets/follow-ups
 * @desc    Get upcoming follow-ups
 * @access  Private
 */
router.get(
  "/follow-ups",
  [
    query("days")
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage("Days must be between 1 and 90"),
    validate,
  ],
  getTicketFollowUps,
);

/**
 * @route   GET /api/tickets/entity/:entityType/:entityId
 * @desc    Get tickets for a CRM entity
 * @access  Private
 */
router.get(
  "/entity/:entityType/:entityId",
  [
    param("entityType")
      .isIn(["lead", "contact", "account", "deal", "client"])
      .withMessage("Invalid entity type"),
    param("entityId").isMongoId().withMessage("Invalid entity ID"),
    validate,
  ],
  getTicketsByEntity,
);

/**
 * @route   GET /api/tickets
 * @desc    Get all tickets with filters
 * @access  Private
 */
router.get(
  "/",
  [
    query("status")
      .optional()
      .isIn([
        "open",
        "in_progress",
        "waiting_on_customer",
        "waiting_on_third_party",
        "resolved",
        "closed",
        "reopened",
      ])
      .withMessage("Invalid status"),
    query("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    validate,
  ],
  getTickets,
);

/**
 * @route   POST /api/tickets
 * @desc    Create a new ticket
 * @access  Private (admin/marketing)
 */
router.post(
  "/",
  authorize("admin", "marketing", "superadmin"),
  [
    body("title")
      .notEmpty()
      .withMessage("Title is required")
      .isLength({ max: 200 })
      .withMessage("Title cannot exceed 200 characters"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    body("type")
      .optional()
      .isIn([
        "lead_inquiry",
        "support",
        "follow_up",
        "complaint",
        "feature_request",
        "general",
      ])
      .withMessage("Invalid type"),
    body("contactEmail").optional().isEmail().withMessage("Invalid email"),
    validate,
  ],
  createTicket,
);

/**
 * @route   PUT /api/tickets/bulk/status
 * @desc    Bulk update ticket status
 * @access  Private (admin)
 */
router.put(
  "/bulk/status",
  authorize("admin", "superadmin"),
  [
    body("ticketIds")
      .isArray({ min: 1, max: 50 })
      .withMessage("Ticket IDs array required (max 50)"),
    body("status")
      .isIn([
        "open",
        "in_progress",
        "waiting_on_customer",
        "waiting_on_third_party",
        "resolved",
        "closed",
        "reopened",
      ])
      .withMessage("Invalid status"),
    validate,
  ],
  bulkUpdateStatus,
);

/**
 * @route   PUT /api/tickets/bulk/assign
 * @desc    Bulk assign tickets
 * @access  Private (admin)
 */
router.put(
  "/bulk/assign",
  authorize("admin", "superadmin"),
  [
    body("ticketIds")
      .isArray({ min: 1, max: 50 })
      .withMessage("Ticket IDs array required (max 50)"),
    body("assignToUserId").isMongoId().withMessage("Valid user ID required"),
    validate,
  ],
  bulkAssignTickets,
);

/**
 * @route   GET /api/tickets/:id
 * @desc    Get ticket details
 * @access  Private
 */
router.get(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid ticket ID"), validate],
  getTicketDetail,
);

/**
 * @route   PUT /api/tickets/:id
 * @desc    Update ticket
 * @access  Private (admin/marketing)
 */
router.put(
  "/:id",
  authorize("admin", "marketing", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid ticket ID"),
    body("title")
      .optional()
      .isLength({ max: 200 })
      .withMessage("Title cannot exceed 200 characters"),
    validate,
  ],
  updateTicket,
);

/**
 * @route   PUT /api/tickets/:id/status
 * @desc    Update ticket status
 * @access  Private (admin/marketing/superadmin)
 */
router.put(
  "/:id/status",
  authorize("admin", "marketing", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid ticket ID"),
    body("status")
      .isIn([
        "open",
        "in_progress",
        "waiting_on_customer",
        "waiting_on_third_party",
        "resolved",
        "closed",
        "reopened",
      ])
      .withMessage("Invalid status"),
    validate,
  ],
  updateTicketStatus,
);

/**
 * @route   PUT /api/tickets/:id/assign
 * @desc    Assign ticket to user
 * @access  Private (admin)
 */
router.put(
  "/:id/assign",
  authorize("admin", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid ticket ID"),
    body("assignToUserId").isMongoId().withMessage("Valid user ID required"),
    validate,
  ],
  assignTicket,
);

/**
 * @route   DELETE /api/tickets/:id
 * @desc    Delete ticket (soft)
 * @access  Private (admin)
 */
router.delete(
  "/:id",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid ticket ID"), validate],
  deleteTicket,
);

/**
 * @route   PUT /api/tickets/:id/restore
 * @desc    Restore deleted ticket
 * @access  Private (admin)
 */
router.put(
  "/:id/restore",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid ticket ID"), validate],
  restoreTicket,
);

// ═══════════════════════════════════════════════════════════
// TICKET REMARKS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /api/tickets/:ticketId/remarks
 * @desc    Get remarks for a ticket
 * @access  Private
 */
router.get(
  "/:ticketId/remarks",
  [param("ticketId").isMongoId().withMessage("Invalid ticket ID"), validate],
  getTicketRemarks,
);

/**
 * @route   POST /api/tickets/:ticketId/remarks
 * @desc    Add remark to a ticket
 * @access  Private
 */
router.post(
  "/:ticketId/remarks",
  [
    param("ticketId").isMongoId().withMessage("Invalid ticket ID"),
    body("content")
      .notEmpty()
      .withMessage("Content is required")
      .isLength({ max: 5000 })
      .withMessage("Content cannot exceed 5000 characters"),
    body("type")
      .optional()
      .isIn([
        "note",
        "call",
        "email",
        "meeting",
        "follow_up",
        "status_change",
        "assignment_change",
        "escalation",
        "resolution",
        "system",
      ])
      .withMessage("Invalid remark type"),
    validate,
  ],
  createTicketRemark,
);

/**
 * @route   PUT /api/tickets/remarks/:id
 * @desc    Update a remark
 * @access  Private (author or admin)
 */
router.put(
  "/remarks/:id",
  [
    param("id").isMongoId().withMessage("Invalid remark ID"),
    body("content")
      .optional()
      .isLength({ max: 5000 })
      .withMessage("Content cannot exceed 5000 characters"),
    validate,
  ],
  updateTicketRemark,
);

/**
 * @route   DELETE /api/tickets/remarks/:id
 * @desc    Delete a remark
 * @access  Private (author or admin)
 */
router.delete(
  "/remarks/:id",
  [param("id").isMongoId().withMessage("Invalid remark ID"), validate],
  deleteTicketRemark,
);

export default router;
