import express from "express";
import { body, param, query } from "express-validator";
import {
  getLeads,
  getLeadDetail,
  createLeadManual,
  updateLead,
  updateLeadStatus,
  assignLead,
  markDuplicate,
  mergeDuplicates,
  getLeadAnalytics,
  getUnassignedCount,
  autoAssignLeads,
  deleteLead,
  uploadLeadAttachments,
  deleteLeadAttachment,
} from "../controllers/leadController.js";
import { protect } from "../middlewares/auth.js";
import { authorize } from "../shared/middlewares/rbacMiddleware.js";
import {
  uploadLeadAttachments as uploadLeadAttachmentsMiddleware,
  handleUploadError,
} from "../middlewares/upload.js";
import {
  getLeadRemarks,
  createLeadRemark,
  updateLeadRemark,
  deleteLeadRemark,
} from "../controllers/leadRemarkController.js";
import { validate } from "../utils/validators.js";

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/leads
 * @desc    Get all leads with filters
 * @access  Private
 */
router.get(
  "/",
  [
    query("status")
      .optional()
      .isIn(["new", "contacted", "interested", "qualified", "closed", "lost"])
      .withMessage("Invalid status"),
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
  getLeads,
);

/**
 * @route   GET /api/leads/unassigned/count
 * @desc    Get count of unassigned leads
 * @access  Private
 */
router.get("/unassigned/count", getUnassignedCount);

/**
 * @route   GET /api/leads/analytics/dashboard
 * @desc    Get lead analytics
 * @access  Private
 */
router.get("/analytics/dashboard", getLeadAnalytics);

/**
 * @route   POST /api/leads
 * @desc    Create a lead manually
 * @access  Private (admin/marketing)
 */
router.post(
  "/",
  authorize("admin", "marketing"),
  [
    body("firstName")
      .trim()
      .notEmpty()
      .withMessage("First name is required")
      .isLength({ min: 1, max: 50 })
      .withMessage("First name must be 1-50 characters"),
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Please provide a valid email")
      .normalizeEmail(),
    body("websiteId")
      .notEmpty()
      .withMessage("Website ID is required")
      .isMongoId()
      .withMessage("Invalid website ID"),
    validate,
  ],
  createLeadManual,
);

/**
 * @route   POST /api/leads/auto-assign
 * @desc    Auto-assign all unassigned leads
 * @access  Private (admin)
 */
router.post(
  "/auto-assign",
  authorize("admin", "superadmin"),
  [
    body("method")
      .optional()
      .isIn(["round_robin", "least_loaded"])
      .withMessage("Invalid assignment method"),
    validate,
  ],
  autoAssignLeads,
);

/**
 * @route   GET /api/leads/:id
 * @desc    Get lead details
 * @access  Private
 */
router.get(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid lead ID"), validate],
  getLeadDetail,
);

/**
 * @route   PUT /api/leads/:id
 * @desc    Update lead
 * @access  Private (admin/marketing)
 */
router.put(
  "/:id",
  authorize("admin", "marketing"),
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    body("firstName")
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("First name must be 1-50 characters"),
    validate,
  ],
  updateLead,
);

/**
 * @route   PUT /api/leads/:id/status
 * @desc    Update lead status
 * @access  Private (marketing/user)
 */
router.put(
  "/:id/status",
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    body("status")
      .notEmpty()
      .withMessage("Status is required")
      .isIn(["new", "contacted", "interested", "qualified", "closed", "lost"])
      .withMessage("Invalid status"),
    validate,
  ],
  updateLeadStatus,
);

/**
 * @route   PUT /api/leads/:id/assign
 * @desc    Assign lead to team member
 * @access  Private (admin)
 */
router.put(
  "/:id/assign",
  authorize("admin", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    body("assignToUserId")
      .notEmpty()
      .withMessage("User ID is required")
      .isMongoId()
      .withMessage("Invalid user ID"),
    validate,
  ],
  assignLead,
);

/**
 * @route   PUT /api/leads/:id/mark-duplicate
 * @desc    Mark lead as duplicate
 * @access  Private (admin)
 */
router.put(
  "/:id/mark-duplicate",
  authorize("admin", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    body("originalLeadId")
      .notEmpty()
      .withMessage("Original lead ID is required")
      .isMongoId()
      .withMessage("Invalid original lead ID"),
    validate,
  ],
  markDuplicate,
);

/**
 * @route   POST /api/leads/:id/merge/:duplicateId
 * @desc    Merge duplicate leads
 * @access  Private (admin)
 */
router.post(
  "/:id/merge/:duplicateId",
  authorize("admin", "superadmin"),
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    param("duplicateId").isMongoId().withMessage("Invalid duplicate ID"),
    validate,
  ],
  mergeDuplicates,
);

/**
 * @route   DELETE /api/leads/:id
 * @desc    Delete lead
 * @access  Private (admin)
 */
router.delete(
  "/:id",
  authorize("admin", "superadmin"),
  [param("id").isMongoId().withMessage("Invalid lead ID"), validate],
  deleteLead,
);

/**
 * @route   POST /api/leads/:id/attachments
 * @desc    Upload files to a lead
 * @access  Private (admin/marketing)
 */
router.post(
  "/:id/attachments",
  authorize("admin", "marketing"),
  [param("id").isMongoId().withMessage("Invalid lead ID"), validate],
  uploadLeadAttachmentsMiddleware,
  handleUploadError,
  uploadLeadAttachments,
);

/**
 * @route   DELETE /api/leads/:id/attachments/:attachmentId
 * @desc    Delete an attachment from a lead
 * @access  Private (admin/marketing)
 */
router.delete(
  "/:id/attachments/:attachmentId",
  authorize("admin", "marketing"),
  [
    param("id").isMongoId().withMessage("Invalid lead ID"),
    param("attachmentId").isMongoId().withMessage("Invalid attachment ID"),
    validate,
  ],
  deleteLeadAttachment,
);

/* ══════════════════════════════════════════
   Lead Remarks
   ══════════════════════════════════════════ */

/**
 * @route   GET /api/leads/:leadId/remarks
 * @desc    Get remarks for a lead
 * @access  Private
 */
router.get(
  "/:leadId/remarks",
  [param("leadId").isMongoId().withMessage("Invalid lead ID"), validate],
  getLeadRemarks,
);

/**
 * @route   POST /api/leads/:leadId/remarks
 * @desc    Add a remark to a lead
 * @access  Private (admin/marketing)
 */
router.post(
  "/:leadId/remarks",
  authorize("admin", "marketing"),
  [
    param("leadId").isMongoId().withMessage("Invalid lead ID"),
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
    validate,
  ],
  createLeadRemark,
);

/**
 * @route   PUT /api/leads/remarks/:id
 * @desc    Update a lead remark
 * @access  Private
 */
router.put(
  "/remarks/:id",
  authorize("admin", "marketing"),
  [
    param("id").isMongoId().withMessage("Invalid remark ID"),
    body("content")
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Remark cannot exceed 2000 characters"),
    validate,
  ],
  updateLeadRemark,
);

/**
 * @route   DELETE /api/leads/remarks/:id
 * @desc    Delete a lead remark
 * @access  Private
 */
router.delete(
  "/remarks/:id",
  authorize("admin", "marketing"),
  [param("id").isMongoId().withMessage("Invalid remark ID"), validate],
  deleteLeadRemark,
);

export default router;
