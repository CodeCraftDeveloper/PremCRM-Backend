import { Parser } from "json2csv";
import Client from "../models/Client.js";
import Event from "../models/Event.js";
import ActivityLog from "../models/ActivityLog.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import logger from "../utils/logger.js";

/**
 * @desc    Export clients to CSV
 * @route   GET /api/export/clients
 * @access  Private
 */
const exportClients = asyncHandler(async (req, res, next) => {
  const { event, marketingPerson, followUpStatus, startDate, endDate } =
    req.query;

  // Build query
  const query = { isActive: true };

  // Role-based filtering
  if (req.user.role === "marketing") {
    query.marketingPerson = req.user._id;
  } else if (marketingPerson) {
    query.marketingPerson = marketingPerson;
  }

  if (event) query.event = event;
  if (followUpStatus) query.followUpStatus = followUpStatus;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  // Fetch data
  const clients = await Client.find(query)
    .populate("event", "name")
    .populate("marketingPerson", "name email")
    .lean();

  if (clients.length === 0) {
    return next(ApiError.notFound("No clients found for export"));
  }

  // Transform data for CSV
  const csvData = clients.map((client) => ({
    Name: client.name,
    Company: client.companyName || "",
    Email: client.email || "",
    Phone: client.phone || "",
    "Alternate Phone": client.alternatePhone || "",
    Address: [
      client.address?.street,
      client.address?.city,
      client.address?.state,
      client.address?.country,
      client.address?.pincode,
    ]
      .filter(Boolean)
      .join(", "),
    Event: client.event?.name || "",
    "Marketing Person": client.marketingPerson?.name || "",
    Status: client.followUpStatus,
    Priority: client.priority,
    "Next Follow-up": client.nextFollowUpDate
      ? new Date(client.nextFollowUpDate).toLocaleDateString()
      : "",
    Industry: client.industry || "",
    Designation: client.designation || "",
    Source: client.source || "",
    "Estimated Value": client.estimatedValue || 0,
    Notes: client.notes || "",
    Tags: client.tags?.join(", ") || "",
    "Created At": new Date(client.createdAt).toLocaleString(),
    "Last Contacted": client.lastContactedDate
      ? new Date(client.lastContactedDate).toLocaleDateString()
      : "",
  }));

  // Generate CSV
  const fields = Object.keys(csvData[0]);
  const parser = new Parser({ fields });
  const csv = parser.parse(csvData);

  // Log activity
  await ActivityLog.log({
    user: req.user._id,
    action: "data_export",
    resourceType: "client",
    description: `Exported ${clients.length} clients to CSV`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(
    `Clients exported by ${req.user.email}: ${clients.length} records`,
  );

  // Set response headers for file download
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=clients_export_${Date.now()}.csv`,
  );

  res.send(csv);
});

/**
 * @desc    Export events to CSV
 * @route   GET /api/export/events
 * @access  Private/Admin
 */
const exportEvents = asyncHandler(async (req, res, next) => {
  const { status } = req.query;

  const query = {};
  if (status) query.status = status;

  const events = await Event.find(query)
    .populate("createdBy", "name email")
    .populate("clientCount")
    .lean();

  if (events.length === 0) {
    return next(ApiError.notFound("No events found for export"));
  }

  const csvData = events.map((event) => ({
    Name: event.name,
    Description: event.description || "",
    Location: event.location || "",
    Status: event.status,
    "Start Date": new Date(event.startDate).toLocaleDateString(),
    "End Date": new Date(event.endDate).toLocaleDateString(),
    "Target Leads": event.targetLeads || 0,
    Budget: event.budget || 0,
    "Client Count": event.clientCount || 0,
    "Created By": event.createdBy?.name || "",
    Tags: event.tags?.join(", ") || "",
    "Created At": new Date(event.createdAt).toLocaleString(),
  }));

  const fields = Object.keys(csvData[0]);
  const parser = new Parser({ fields });
  const csv = parser.parse(csvData);

  // Log activity
  await ActivityLog.log({
    user: req.user._id,
    action: "data_export",
    resourceType: "event",
    description: `Exported ${events.length} events to CSV`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(`Events exported by ${req.user.email}: ${events.length} records`);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=events_export_${Date.now()}.csv`,
  );

  res.send(csv);
});

/**
 * @desc    Export activity logs
 * @route   GET /api/export/activity-logs
 * @access  Private/Admin
 */
const exportActivityLogs = asyncHandler(async (req, res, next) => {
  const { userId, action, startDate, endDate, limit = 1000 } = req.query;

  const query = {};
  if (userId) query.user = userId;
  if (action) query.action = action;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const logs = await ActivityLog.find(query)
    .populate("user", "name email")
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .lean();

  if (logs.length === 0) {
    return next(ApiError.notFound("No activity logs found for export"));
  }

  const csvData = logs.map((log) => ({
    User: log.user?.name || "System",
    Email: log.user?.email || "",
    Action: log.action,
    "Resource Type": log.resourceType,
    Description: log.description,
    "IP Address": log.ipAddress || "",
    Timestamp: new Date(log.createdAt).toLocaleString(),
  }));

  const fields = Object.keys(csvData[0]);
  const parser = new Parser({ fields });
  const csv = parser.parse(csvData);

  logger.info(
    `Activity logs exported by ${req.user.email}: ${logs.length} records`,
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=activity_logs_export_${Date.now()}.csv`,
  );

  res.send(csv);
});

/**
 * @desc    Get export summary/options
 * @route   GET /api/export/summary
 * @access  Private
 */
const getExportSummary = asyncHandler(async (req, res, next) => {
  const clientCount = await Client.countDocuments({
    isActive: true,
    ...(req.user.role === "marketing" ? { marketingPerson: req.user._id } : {}),
  });

  const eventCount = await Event.countDocuments();
  const activityLogCount = await ActivityLog.countDocuments();

  successResponse(res, {
    availableExports: [
      {
        type: "clients",
        count: clientCount,
        description: "Export all client records",
        filters: ["event", "marketingPerson", "followUpStatus", "dateRange"],
      },
      ...(req.user.role === "admin"
        ? [
            {
              type: "events",
              count: eventCount,
              description: "Export all event records",
              filters: ["status"],
            },
            {
              type: "activity-logs",
              count: activityLogCount,
              description: "Export activity logs",
              filters: ["userId", "action", "dateRange"],
            },
          ]
        : []),
    ],
  });
});

export { exportClients, exportEvents, exportActivityLogs, getExportSummary };
