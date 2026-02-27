import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import Ticket from "../models/Ticket.js";
import AuditLog from "../models/AuditLog.js";
import ActivityLog from "../models/ActivityLog.js";
import logger from "../utils/logger.js";

/**
 * @desc    Get all tickets for tenant
 * @route   GET /api/tickets
 * @access  Private
 */
export const getTickets = asyncHandler(async (req, res, next) => {
  try {
    const {
      status,
      priority,
      type,
      assignedTo,
      slaBreached,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 20,
      entityType,
      entityId,
      overdue,
      unassigned,
    } = req.query;

    const query = {
      tenantId: req.user.tenantId,
      deletedAt: null,
    };

    // Role-based filtering: marketing users only see their assigned tickets
    if (req.user.role === "marketing") {
      query.assignedTo = req.user._id;
    }

    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;
    if (assignedTo) query.assignedTo = assignedTo;
    if (slaBreached === "true") query.slaBreached = true;
    if (unassigned === "true") query.assignedTo = null;
    if (overdue === "true") {
      query.dueDate = { $lt: new Date() };
      query.status = { $nin: ["resolved", "closed"] };
    }
    if (entityType && entityId) {
      query["relatedEntity.entityType"] = entityType;
      query["relatedEntity.entityId"] = entityId;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { ticketNumber: { $regex: search, $options: "i" } },
        { contactName: { $regex: search, $options: "i" } },
        { contactEmail: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [tickets, totalDocs] = await Promise.all([
      Ticket.find(query)
        .populate("assignedTo", "name email")
        .populate("createdBy", "name email")
        .populate("websiteId", "name domain")
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Ticket.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalDocs / limitNum);

    paginatedResponse(
      res,
      { tickets },
      { page: pageNum, limit: limitNum, totalPages, totalDocs },
      "Tickets retrieved successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get single ticket
 * @route   GET /api/tickets/:id
 * @access  Private
 */
export const getTicketDetail = asyncHandler(async (req, res, next) => {
  try {
    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    })
      .populate("assignedTo", "name email")
      .populate("assignedBy", "name email")
      .populate("createdBy", "name email")
      .populate("websiteId", "name domain")
      .populate("statusHistory.changedBy", "name email");

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    // Marketing users can only view their assigned tickets
    if (
      req.user.role === "marketing" &&
      ticket.assignedTo?._id?.toString() !== req.user._id.toString()
    ) {
      return next(
        ApiError.forbidden("You can only view your assigned tickets"),
      );
    }

    successResponse(res, { ticket }, "Ticket details retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create ticket
 * @route   POST /api/tickets
 * @access  Private (admin/marketing)
 */
export const createTicket = asyncHandler(async (req, res, next) => {
  try {
    const {
      title,
      description,
      priority,
      type,
      channel,
      assignedTo,
      contactName,
      contactEmail,
      contactPhone,
      companyName,
      dueDate,
      nextFollowUpDate,
      tags,
      websiteId,
      source,
      relatedEntity,
    } = req.body;

    if (!title) {
      return next(ApiError.badRequest("Ticket title is required"));
    }

    const ticketData = {
      tenantId: req.user.tenantId,
      title,
      description,
      priority: priority || "medium",
      type: type || "general",
      channel: channel || "manual",
      contactName,
      contactEmail,
      contactPhone,
      companyName,
      dueDate,
      nextFollowUpDate,
      tags,
      websiteId,
      source,
      createdBy: req.user._id,
      statusHistory: [
        {
          toStatus: "open",
          changedBy: req.user._id,
          changedAt: new Date(),
          note: "Ticket created",
        },
      ],
    };

    if (assignedTo) {
      ticketData.assignedTo = assignedTo;
      ticketData.assignedAt = new Date();
      ticketData.assignedBy = req.user._id;
    }

    if (relatedEntity?.entityType && relatedEntity?.entityId) {
      ticketData.relatedEntity = {
        entityType: relatedEntity.entityType,
        entityId: relatedEntity.entityId,
      };
    }

    const ticket = await Ticket.create(ticketData);

    const populatedTicket = await Ticket.findById(ticket._id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email")
      .lean();

    // Audit log
    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "ticket.create",
      entityType: "ticket",
      entityId: ticket._id,
      description: `Ticket "${title}" created by ${req.user.name}`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(
      res,
      { ticket: populatedTicket },
      "Ticket created successfully",
      201,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update ticket
 * @route   PUT /api/tickets/:id
 * @access  Private (admin/marketing)
 */
export const updateTicket = asyncHandler(async (req, res, next) => {
  try {
    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    const allowedFields = [
      "title",
      "description",
      "priority",
      "type",
      "channel",
      "contactName",
      "contactEmail",
      "contactPhone",
      "companyName",
      "dueDate",
      "nextFollowUpDate",
      "tags",
      "source",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const updatedTicket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.user.tenantId },
      updates,
      { new: true },
    )
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email");

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "ticket.update",
      entityType: "ticket",
      entityId: ticket._id,
      description: `Ticket "${ticket.title}" updated by ${req.user.name}`,
      metadata: { updatedFields: Object.keys(updates) },
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(
      res,
      { ticket: updatedTicket },
      "Ticket updated successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update ticket status
 * @route   PUT /api/tickets/:id/status
 * @access  Private
 */
export const updateTicketStatus = asyncHandler(async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const { TICKET_STATUSES } = await import("../models/Ticket.js");

    if (!status || !TICKET_STATUSES.includes(status)) {
      return next(
        ApiError.badRequest(
          `Invalid status. Allowed: ${TICKET_STATUSES.join(", ")}`,
        ),
      );
    }

    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    const previousStatus = ticket.status;
    ticket.status = status;

    // Track status change in history
    ticket.statusHistory.push({
      fromStatus: previousStatus,
      toStatus: status,
      changedBy: req.user._id,
      changedAt: new Date(),
      note: note || "",
    });

    // Track first response
    if (
      !ticket.firstResponseAt &&
      previousStatus === "open" &&
      status !== "open"
    ) {
      ticket.firstResponseAt = new Date();
    }

    await ticket.save();

    // Create status change remark
    const TicketRemark = (await import("../models/TicketRemark.js")).default;
    await TicketRemark.createStatusChangeRemark(
      ticket._id,
      req.user._id,
      previousStatus,
      status,
      note,
      req.user.tenantId,
    );

    const updatedTicket = await Ticket.findById(ticket._id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email")
      .populate("statusHistory.changedBy", "name email");

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "ticket.status_change",
      entityType: "ticket",
      entityId: ticket._id,
      description: `Ticket status changed: ${previousStatus} → ${status}`,
      metadata: { previousStatus, newStatus: status, note },
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(
      res,
      { ticket: updatedTicket },
      "Ticket status updated successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Assign ticket
 * @route   PUT /api/tickets/:id/assign
 * @access  Private (admin)
 */
export const assignTicket = asyncHandler(async (req, res, next) => {
  try {
    const { assignToUserId } = req.body;

    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    // Verify assignee belongs to the same tenant
    const User = (await import("../models/User.js")).default;
    const assignee = await User.findOne({
      _id: assignToUserId,
      tenantId: req.user.tenantId,
    });

    if (!assignee) {
      return next(ApiError.notFound("User not found in your organization"));
    }

    const previousAssignee = ticket.assignedTo;
    ticket.assignedTo = assignToUserId;
    ticket.assignedAt = new Date();
    ticket.assignedBy = req.user._id;

    // Auto-move to in_progress if currently open
    if (ticket.status === "open") {
      ticket.statusHistory.push({
        fromStatus: "open",
        toStatus: "in_progress",
        changedBy: req.user._id,
        changedAt: new Date(),
        note: `Auto-assigned to ${assignee.name}`,
      });
      ticket.status = "in_progress";
    }

    await ticket.save();

    // Create assignment remark
    const TicketRemark = (await import("../models/TicketRemark.js")).default;
    await TicketRemark.createAssignmentRemark(
      ticket._id,
      req.user._id,
      assignee.name,
      undefined,
      req.user.tenantId,
    );

    const updatedTicket = await Ticket.findById(ticket._id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email");

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "ticket.assign",
      entityType: "ticket",
      entityId: ticket._id,
      description: `Ticket assigned to ${assignee.name}`,
      metadata: { previousAssignee, newAssignee: assignToUserId },
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(
      res,
      { ticket: updatedTicket },
      "Ticket assigned successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete ticket (soft)
 * @route   DELETE /api/tickets/:id
 * @access  Private (admin)
 */
export const deleteTicket = asyncHandler(async (req, res, next) => {
  try {
    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: null,
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found"));
    }

    ticket.deletedAt = new Date();
    ticket.deletedBy = req.user._id;
    await ticket.save();

    AuditLog.record({
      tenantId: req.user.tenantId,
      userId: req.user._id,
      action: "ticket.delete",
      entityType: "ticket",
      entityId: ticket._id,
      description: `Ticket "${ticket.title}" deleted`,
      requestId: req.requestId,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
    });

    successResponse(res, null, "Ticket deleted successfully");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Restore deleted ticket
 * @route   PUT /api/tickets/:id/restore
 * @access  Private (admin)
 */
export const restoreTicket = asyncHandler(async (req, res, next) => {
  try {
    const ticket = await Ticket.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
      deletedAt: { $ne: null },
    });

    if (!ticket) {
      return next(ApiError.notFound("Ticket not found or not deleted"));
    }

    ticket.deletedAt = null;
    ticket.deletedBy = null;
    await ticket.save();

    const restoredTicket = await Ticket.findById(ticket._id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email");

    successResponse(
      res,
      { ticket: restoredTicket },
      "Ticket restored successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get ticket stats/analytics
 * @route   GET /api/tickets/stats
 * @access  Private
 */
export const getTicketStats = asyncHandler(async (req, res, next) => {
  try {
    const filters = {};
    if (req.user.role === "marketing") {
      filters.assignedTo = req.user._id;
    }

    const stats = await Ticket.getStats(req.user.tenantId, filters);

    // Calculate avg resolution time for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const resolutionTimes = await Ticket.aggregate([
      {
        $match: {
          tenantId: req.user.tenantId,
          resolvedAt: { $gte: thirtyDaysAgo },
          deletedAt: null,
        },
      },
      {
        $project: {
          resolutionTime: { $subtract: ["$resolvedAt", "$createdAt"] },
        },
      },
      {
        $group: {
          _id: null,
          avgResolutionTime: { $avg: "$resolutionTime" },
          count: { $sum: 1 },
        },
      },
    ]);

    const avgResolutionMs = resolutionTimes[0]?.avgResolutionTime || 0;
    const avgResolutionHours =
      Math.round((avgResolutionMs / (1000 * 60 * 60)) * 10) / 10;

    successResponse(
      res,
      {
        ...stats,
        avgResolutionHours,
        resolvedLast30Days: resolutionTimes[0]?.count || 0,
      },
      "Ticket stats retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get upcoming follow-ups
 * @route   GET /api/tickets/follow-ups
 * @access  Private
 */
export const getTicketFollowUps = asyncHandler(async (req, res, next) => {
  try {
    const { days = 7 } = req.query;
    const tickets = await Ticket.getUpcomingFollowUps(
      req.user.tenantId,
      parseInt(days),
    );

    successResponse(res, { tickets }, "Follow-ups retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Bulk update ticket status
 * @route   PUT /api/tickets/bulk/status
 * @access  Private (admin)
 */
export const bulkUpdateStatus = asyncHandler(async (req, res, next) => {
  try {
    const { ticketIds, status, note } = req.body;
    const { TICKET_STATUSES } = await import("../models/Ticket.js");

    if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
      return next(ApiError.badRequest("Ticket IDs array is required"));
    }

    if (!TICKET_STATUSES.includes(status)) {
      return next(ApiError.badRequest("Invalid status"));
    }

    if (ticketIds.length > 50) {
      return next(
        ApiError.badRequest("Cannot bulk update more than 50 tickets at once"),
      );
    }

    const result = await Ticket.updateMany(
      {
        _id: { $in: ticketIds },
        tenantId: req.user.tenantId,
        deletedAt: null,
      },
      {
        $set: { status },
        $push: {
          statusHistory: {
            toStatus: status,
            changedBy: req.user._id,
            changedAt: new Date(),
            note: note || `Bulk status update to ${status}`,
          },
        },
      },
    );

    successResponse(
      res,
      { modifiedCount: result.modifiedCount },
      `${result.modifiedCount} tickets updated`,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Bulk assign tickets
 * @route   PUT /api/tickets/bulk/assign
 * @access  Private (admin)
 */
export const bulkAssignTickets = asyncHandler(async (req, res, next) => {
  try {
    const { ticketIds, assignToUserId } = req.body;

    if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
      return next(ApiError.badRequest("Ticket IDs array is required"));
    }

    if (ticketIds.length > 50) {
      return next(
        ApiError.badRequest("Cannot bulk assign more than 50 tickets at once"),
      );
    }

    // Verify assignee belongs to tenant
    const User = (await import("../models/User.js")).default;
    const assignee = await User.findOne({
      _id: assignToUserId,
      tenantId: req.user.tenantId,
    });

    if (!assignee) {
      return next(ApiError.notFound("User not found in your organization"));
    }

    const result = await Ticket.updateMany(
      {
        _id: { $in: ticketIds },
        tenantId: req.user.tenantId,
        deletedAt: null,
      },
      {
        $set: {
          assignedTo: assignToUserId,
          assignedAt: new Date(),
          assignedBy: req.user._id,
        },
      },
    );

    successResponse(
      res,
      { modifiedCount: result.modifiedCount },
      `${result.modifiedCount} tickets assigned to ${assignee.name}`,
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get tickets for a related entity (lead/contact/account/deal)
 * @route   GET /api/tickets/entity/:entityType/:entityId
 * @access  Private
 */
export const getTicketsByEntity = asyncHandler(async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    const validTypes = ["lead", "contact", "account", "deal", "client"];

    if (!validTypes.includes(entityType)) {
      return next(
        ApiError.badRequest(
          `Invalid entity type. Allowed: ${validTypes.join(", ")}`,
        ),
      );
    }

    const tickets = await Ticket.find({
      tenantId: req.user.tenantId,
      "relatedEntity.entityType": entityType,
      "relatedEntity.entityId": entityId,
      deletedAt: null,
    })
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    successResponse(res, { tickets }, "Entity tickets retrieved");
  } catch (error) {
    next(error);
  }
});
