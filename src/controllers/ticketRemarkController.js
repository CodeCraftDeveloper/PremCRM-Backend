import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import TicketRemark from "../models/TicketRemark.js";
import Ticket from "../models/Ticket.js";

/**
 * @desc    Get remarks for a ticket
 * @route   GET /api/tickets/:ticketId/remarks
 * @access  Private
 */
export const getTicketRemarks = asyncHandler(async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { page = 1, limit = 30, type } = req.query;

    // Verify ticket exists and belongs to tenant
    const ticket = await Ticket.findOne({
      _id: ticketId,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    const query = { ticket: ticketId, tenantId: req.user.tenantId };
    if (type) query.type = type;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    const [remarks, totalDocs] = await Promise.all([
      TicketRemark.find(query)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("user", "name email avatar")
        .lean(),
      TicketRemark.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalDocs / limitNum);

    paginatedResponse(
      res,
      remarks,
      { page: pageNum, limit: limitNum, totalPages, totalDocs },
      "Remarks retrieved successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create remark on a ticket
 * @route   POST /api/tickets/:ticketId/remarks
 * @access  Private
 */
export const createTicketRemark = asyncHandler(async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const {
      content,
      type = "note",
      isInternal = false,
      isPinned = false,
      callDuration,
      callOutcome,
      scheduledFollowUp,
    } = req.body;

    if (!content || !content.trim()) {
      return next(ApiError.badRequest("Remark content is required"));
    }

    // Verify ticket exists and belongs to tenant
    const ticket = await Ticket.findOne({
      _id: ticketId,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    const remarkData = {
      ticket: ticketId,
      user: req.user._id,
      tenantId: req.user.tenantId,
      content: content.trim(),
      type,
      isInternal,
      isPinned,
    };

    if (type === "call") {
      if (callDuration) remarkData.callDuration = callDuration;
      if (callOutcome) remarkData.callOutcome = callOutcome;
    }

    if (scheduledFollowUp) {
      remarkData.scheduledFollowUp = scheduledFollowUp;
      // Also update the ticket's nextFollowUpDate
      ticket.nextFollowUpDate = scheduledFollowUp;
    }

    // Update last contacted
    if (["call", "email", "meeting"].includes(type)) {
      ticket.lastContactedAt = new Date();
      ticket.contactAttempts = (ticket.contactAttempts || 0) + 1;
    }

    await ticket.save();

    const remark = await TicketRemark.create(remarkData);

    const populatedRemark = await TicketRemark.findById(remark._id)
      .populate("user", "name email avatar")
      .lean();

    successResponse(
      res,
      { remark: populatedRemark },
      "Remark added successfully",
      201,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update a remark
 * @route   PUT /api/tickets/remarks/:id
 * @access  Private (author or admin)
 */
export const updateTicketRemark = asyncHandler(async (req, res, next) => {
  try {
    const remark = await TicketRemark.findById(req.params.id);

    if (!remark) {
      return next(ApiError.notFound("Remark not found"));
    }

    // SECURITY: Verify parent ticket belongs to the requesting user's tenant
    const parentTicket = await Ticket.findOne({
      _id: remark.ticket,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!parentTicket) {
      return next(ApiError.notFound("Remark not found"));
    }

    // Only author or admin can update
    if (
      remark.user.toString() !== req.user._id.toString() &&
      !["admin", "superadmin"].includes(req.user.role)
    ) {
      return next(ApiError.forbidden("You can only edit your own remarks"));
    }

    const { content, type, isInternal, isPinned } = req.body;
    if (content !== undefined) remark.content = content.trim();
    if (type !== undefined) remark.type = type;
    if (isInternal !== undefined) remark.isInternal = isInternal;
    if (isPinned !== undefined) remark.isPinned = isPinned;

    await remark.save();

    const updatedRemark = await TicketRemark.findById(remark._id)
      .populate("user", "name email avatar")
      .lean();

    successResponse(
      res,
      { remark: updatedRemark },
      "Remark updated successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete a remark
 * @route   DELETE /api/tickets/remarks/:id
 * @access  Private (author or admin)
 */
export const deleteTicketRemark = asyncHandler(async (req, res, next) => {
  try {
    const remark = await TicketRemark.findById(req.params.id);

    if (!remark) {
      return next(ApiError.notFound("Remark not found"));
    }

    // SECURITY: Verify parent ticket belongs to the requesting user's tenant
    const parentTicket = await Ticket.findOne({
      _id: remark.ticket,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!parentTicket) {
      return next(ApiError.notFound("Remark not found"));
    }

    // Only author or admin can delete
    if (
      remark.user.toString() !== req.user._id.toString() &&
      !["admin", "superadmin"].includes(req.user.role)
    ) {
      return next(ApiError.forbidden("You can only delete your own remarks"));
    }

    await TicketRemark.findByIdAndDelete(req.params.id);

    successResponse(res, null, "Remark deleted successfully");
  } catch (error) {
    next(error);
  }
});
