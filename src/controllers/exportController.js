import { Parser } from "json2csv";
import ExcelJS from "exceljs";
import Client from "../models/Client.js";
import Event from "../models/Event.js";
import ActivityLog from "../models/ActivityLog.js";
import Lead from "../models/Lead.js";
import Website from "../models/Website.js";
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

  // Build query — always scope to current tenant
  const query = { isActive: true, tenantId: req.user.tenantId };

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
    tenantId: req.user.tenantId,
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

  const query = { tenantId: req.user.tenantId };
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
    tenantId: req.user.tenantId,
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

  const query = { tenantId: req.user.tenantId };
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
    tenantId: req.user.tenantId,
    isActive: true,
    ...(req.user.role === "marketing" ? { marketingPerson: req.user._id } : {}),
  });

  const eventCount = await Event.countDocuments({
    tenantId: req.user.tenantId,
  });
  const activityLogCount = await ActivityLog.countDocuments({
    tenantId: req.user.tenantId,
  });

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

/**
 * @desc    Export leads/queries to Excel (XLSX) grouped by website source
 * @route   GET /api/export/leads
 * @access  Private (admin, marketing)
 */
const exportLeads = asyncHandler(async (req, res, next) => {
  const {
    status,
    websiteId,
    assignedTo,
    source,
    startDate,
    endDate,
    groupByWebsite,
  } = req.query;

  // Build query
  const query = { tenantId: req.user.tenantId };

  // Role-based filtering: marketing sees only their assigned leads
  if (req.user.role === "marketing") {
    query.assignedTo = req.user._id;
  } else if (assignedTo) {
    query.assignedTo = assignedTo;
  }

  if (status) query.status = status;
  if (websiteId) query.websiteId = websiteId;
  if (source) query.source = source;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  // Fetch leads with populated references
  const leads = await Lead.find(query)
    .populate("websiteId", "name domain category")
    .populate("assignedTo", "name email")
    .sort({ createdAt: -1 })
    .limit(10000)
    .lean();

  if (leads.length === 0) {
    return next(ApiError.notFound("No leads found for export"));
  }

  // Create workbook
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prem CRM";
  workbook.created = new Date();

  // Header style
  const headerStyle = {
    font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } },
    alignment: { horizontal: "center", vertical: "middle" },
    border: {
      top: { style: "thin" },
      bottom: { style: "thin" },
      left: { style: "thin" },
      right: { style: "thin" },
    },
  };

  const cellBorder = {
    top: { style: "thin", color: { argb: "FFD1D5DB" } },
    bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
    left: { style: "thin", color: { argb: "FFD1D5DB" } },
    right: { style: "thin", color: { argb: "FFD1D5DB" } },
  };

  // Status color map for cells
  const statusColors = {
    new: "FF3B82F6",
    contacted: "FFEAB308",
    interested: "FF8B5CF6",
    qualified: "FF22C55E",
    closed: "FF10B981",
    lost: "FFEF4444",
  };

  // Columns definition
  const columns = [
    { header: "S.No", key: "sno", width: 8 },
    { header: "Full Name", key: "fullName", width: 22 },
    { header: "Email", key: "email", width: 28 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Company", key: "company", width: 22 },
    { header: "Product Interest", key: "productInterest", width: 22 },
    { header: "Source Website", key: "websiteName", width: 24 },
    { header: "Domain", key: "domain", width: 24 },
    { header: "Source Type", key: "sourceType", width: 16 },
    { header: "Status", key: "status", width: 14 },
    { header: "Score", key: "score", width: 10 },
    { header: "Assigned To", key: "assignedTo", width: 20 },
    { header: "City", key: "city", width: 16 },
    { header: "State", key: "state", width: 16 },
    { header: "Country", key: "country", width: 16 },
    { header: "Message", key: "message", width: 35 },
    { header: "Notes", key: "notes", width: 30 },
    { header: "Tags", key: "tags", width: 20 },
    { header: "Is Duplicate", key: "isDuplicate", width: 14 },
    { header: "Contact Attempts", key: "contactAttempts", width: 16 },
    { header: "Created At", key: "createdAt", width: 20 },
    { header: "Last Contacted", key: "lastContactedAt", width: 20 },
  ];

  // Helper to add data rows to a worksheet
  const addLeadRows = (ws, leadsData) => {
    leadsData.forEach((lead, idx) => {
      const row = ws.addRow({
        sno: idx + 1,
        fullName:
          lead.fullName ||
          `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),
        email: lead.email || "",
        phone: lead.phone || "",
        company: lead.company || "",
        productInterest: lead.productInterest || "",
        websiteName: lead.websiteId?.name || "Unknown",
        domain: lead.websiteId?.domain || "",
        sourceType: lead.source || "",
        status: lead.status?.charAt(0).toUpperCase() + lead.status?.slice(1),
        score: lead.score || 0,
        assignedTo: lead.assignedTo?.name || "Unassigned",
        city: lead.city || "",
        state: lead.state || "",
        country: lead.country || "",
        message: lead.message || "",
        notes: lead.notes || "",
        tags: lead.tags?.join(", ") || "",
        isDuplicate: lead.isDuplicate ? "Yes" : "No",
        contactAttempts: lead.contactAttempts || 0,
        createdAt: lead.createdAt
          ? new Date(lead.createdAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "",
        lastContactedAt: lead.lastContactedAt
          ? new Date(lead.lastContactedAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "",
      });

      // Apply cell borders and styles
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = cellBorder;
        cell.alignment = { vertical: "middle", wrapText: true };
      });

      // Color-code status cell
      const statusCell = row.getCell("status");
      const colorArgb = statusColors[lead.status] || "FF6B7280";
      statusCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      statusCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: colorArgb },
      };
      statusCell.alignment = { horizontal: "center", vertical: "middle" };

      // Highlight duplicates in orange
      if (lead.isDuplicate) {
        const dupCell = row.getCell("isDuplicate");
        dupCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        dupCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF97316" },
        };
        dupCell.alignment = { horizontal: "center" };
      }

      // Alternate row shading
      if (idx % 2 === 0) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (!cell.fill || cell.fill.pattern !== "solid") {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF1F5F9" },
            };
          }
        });
      }
    });
  };

  // Style header row for a worksheet
  const styleHeaderRow = (ws) => {
    const hRow = ws.getRow(1);
    hRow.height = 30;
    hRow.eachCell((cell) => {
      cell.font = headerStyle.font;
      cell.fill = headerStyle.fill;
      cell.alignment = headerStyle.alignment;
      cell.border = headerStyle.border;
    });
    ws.autoFilter = {
      from: "A1",
      to: `${String.fromCharCode(64 + columns.length)}1`,
    };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  // Check if groupByWebsite is requested
  if (groupByWebsite === "true") {
    // Group leads by website
    const groupedByWebsite = {};
    leads.forEach((lead) => {
      const wsName = lead.websiteId?.name || "Unknown Source";
      if (!groupedByWebsite[wsName]) groupedByWebsite[wsName] = [];
      groupedByWebsite[wsName].push(lead);
    });

    // Create a sheet per website
    Object.entries(groupedByWebsite).forEach(([websiteName, websiteLeads]) => {
      // Sheet name max 31 chars, remove invalid chars
      const sheetName = websiteName
        .replace(/[\\/*?:\[\]]/g, "")
        .substring(0, 31);
      const ws = workbook.addWorksheet(sheetName);
      ws.columns = columns;
      styleHeaderRow(ws);
      addLeadRows(ws, websiteLeads);
    });

    // Also add a summary sheet
    const summaryWs = workbook.addWorksheet("Summary");
    summaryWs.columns = [
      { header: "Website / Source", key: "website", width: 30 },
      { header: "Domain", key: "domain", width: 30 },
      { header: "Total Queries", key: "total", width: 16 },
      { header: "New", key: "new", width: 12 },
      { header: "Contacted", key: "contacted", width: 14 },
      { header: "Interested", key: "interested", width: 14 },
      { header: "Qualified", key: "qualified", width: 14 },
      { header: "Closed", key: "closed", width: 12 },
      { header: "Lost", key: "lost", width: 12 },
      { header: "Duplicates", key: "duplicates", width: 14 },
      { header: "Avg Score", key: "avgScore", width: 12 },
    ];

    const sHRow = summaryWs.getRow(1);
    sHRow.height = 30;
    sHRow.eachCell((cell) => {
      cell.font = headerStyle.font;
      cell.fill = headerStyle.fill;
      cell.alignment = headerStyle.alignment;
      cell.border = headerStyle.border;
    });

    Object.entries(groupedByWebsite).forEach(([websiteName, websiteLeads]) => {
      const statusCounts = {
        new: 0,
        contacted: 0,
        interested: 0,
        qualified: 0,
        closed: 0,
        lost: 0,
      };
      let totalScore = 0;
      let dupCount = 0;
      websiteLeads.forEach((l) => {
        if (statusCounts[l.status] !== undefined) statusCounts[l.status]++;
        totalScore += l.score || 0;
        if (l.isDuplicate) dupCount++;
      });
      const row = summaryWs.addRow({
        website: websiteName,
        domain: websiteLeads[0]?.websiteId?.domain || "",
        total: websiteLeads.length,
        ...statusCounts,
        duplicates: dupCount,
        avgScore: websiteLeads.length
          ? Math.round(totalScore / websiteLeads.length)
          : 0,
      });
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = cellBorder;
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
      row.getCell("website").alignment = {
        horizontal: "left",
        vertical: "middle",
      };
      row.getCell("domain").alignment = {
        horizontal: "left",
        vertical: "middle",
      };
    });
  } else {
    // Single sheet with all leads
    const ws = workbook.addWorksheet("All Queries");
    ws.columns = columns;
    styleHeaderRow(ws);
    addLeadRows(ws, leads);
  }

  // Log activity
  await ActivityLog.log({
    tenantId: req.user.tenantId,
    user: req.user._id,
    action: "data_export",
    resourceType: "lead",
    description: `Exported ${leads.length} leads/queries to Excel`,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  logger.info(
    `Leads exported to Excel by ${req.user.email}: ${leads.length} records`,
  );

  // Set response headers for XLSX download
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=queries_export_${Date.now()}.xlsx`,
  );

  await workbook.xlsx.write(res);
  res.end();
});

/**
 * @desc    Export leads per-website summary to Excel
 * @route   GET /api/export/leads/summary
 * @access  Private (admin)
 */
const exportLeadsSummary = asyncHandler(async (req, res, next) => {
  const websites = await Website.find({ tenantId: req.user.tenantId })
    .select("name domain category stats isActive")
    .lean();

  if (!websites.length) {
    return next(ApiError.notFound("No websites found"));
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prem CRM";
  workbook.created = new Date();

  const ws = workbook.addWorksheet("Website Query Summary");
  ws.columns = [
    { header: "S.No", key: "sno", width: 8 },
    { header: "Website Name", key: "name", width: 28 },
    { header: "Domain", key: "domain", width: 28 },
    { header: "Category", key: "category", width: 18 },
    { header: "Status", key: "active", width: 12 },
    { header: "Total Leads", key: "totalLeads", width: 14 },
    { header: "This Month", key: "leadsThisMonth", width: 14 },
    { header: "Duplicates", key: "duplicates", width: 14 },
    { header: "Last Lead", key: "lastLead", width: 22 },
  ];

  const hRow = ws.getRow(1);
  hRow.height = 30;
  hRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF059669" },
    };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: { style: "thin" },
      bottom: { style: "thin" },
      left: { style: "thin" },
      right: { style: "thin" },
    };
  });
  ws.autoFilter = "A1:I1";
  ws.views = [{ state: "frozen", ySplit: 1 }];

  websites.forEach((site, idx) => {
    const row = ws.addRow({
      sno: idx + 1,
      name: site.name,
      domain: site.domain,
      category: site.category,
      active: site.isActive ? "Active" : "Inactive",
      totalLeads: site.stats?.totalLeads || 0,
      leadsThisMonth: site.stats?.leadsThisMonth || 0,
      duplicates: site.stats?.duplicatesDetected || 0,
      lastLead: site.stats?.lastLeadAt
        ? new Date(site.stats.lastLeadAt).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })
        : "No leads yet",
    });
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFD1D5DB" } },
        bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
        left: { style: "thin", color: { argb: "FFD1D5DB" } },
        right: { style: "thin", color: { argb: "FFD1D5DB" } },
      };
      cell.alignment = { vertical: "middle" };
    });
  });

  logger.info(`Website summary exported to Excel by ${req.user.email}`);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=website_summary_${Date.now()}.xlsx`,
  );

  await workbook.xlsx.write(res);
  res.end();
});

export {
  exportClients,
  exportEvents,
  exportActivityLogs,
  getExportSummary,
  exportLeads,
  exportLeadsSummary,
};
