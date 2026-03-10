import mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import Website from "../../models/Website.js";
import LeadActivity from "../../models/LeadActivity.js";
import DuplicateDetectionService from "./DuplicateDetectionService.js";
import AssignmentService from "./AssignmentService.js";
import logger from "../../utils/logger.js";
import { buildSafeSearch } from "../../utils/safeQueryBuilder.js";

/**
 * Comprehensive Lead Service
 * Handles lead creation, updates, and business logic
 */
class LeadService {
  /**
   * Create a new lead with duplicate detection and auto-assignment
   * @param {Object} leadData - Lead information {firstName, lastName, email, phone, message, etc.}
   * @param {ObjectId} websiteId - Website ID (source)
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Object} metadata - Request metadata {ipAddress, userAgent}
   * @returns {Promise<Object>} Created lead or duplicate detection result
   */
  static async createLead(leadData, websiteId, tenantId, metadata = {}) {
    try {
      // Get website for duplicate settings
      const website = await Website.findOne(
        { _id: websiteId, tenantId },
        "duplicateSettings rateLimit",
      );

      if (!website) {
        throw new Error("Website not found");
      }

      // Check for duplicates
      const duplicates = await DuplicateDetectionService.findDuplicates(
        leadData.email,
        leadData.phone,
        tenantId,
        websiteId,
        website.duplicateSettings,
      );

      // Handle duplicates
      let isDuplicate = false;
      let duplicateOf = null;

      if (duplicates.length > 0) {
        // Pick the most recent original lead
        const originalLead = duplicates.sort(
          (a, b) => b.createdAt - a.createdAt,
        )[0];

        // Append remark/note instead of creating duplicate
        const noteAppend = `\n\n[${new Date().toISOString()}] Duplicate submission received:\nEmail: ${leadData.email}\nPhone: ${leadData.phone}`;
        await Lead.findByIdAndUpdate(
          originalLead._id,
          {
            $set: {
              notes: (originalLead.notes || "") + noteAppend,
            },
          },
          { new: true },
        );

        // Log duplicate detection
        await LeadActivity.create({
          tenantId,
          leadId: originalLead._id,
          action: "duplicate_detected",
          description: `Duplicate lead attempt detected with email: ${leadData.email}`,
          performedByName: "System",
          metadata: {
            ipAddress: metadata.ipAddress,
            newSubmissionData: leadData,
          },
        });

        isDuplicate = true;
        duplicateOf = originalLead._id;
      }

      // Create lead
      const newLead = await Lead.create({
        tenantId,
        websiteId,
        fullName: `${leadData.firstName} ${leadData.lastName || ""}`.trim(),
        firstName: leadData.firstName,
        lastName: leadData.lastName || "",
        email: leadData.email?.toLowerCase(),
        phone: leadData.phone,
        message: leadData.message,
        source: leadData.source || website.category || "contact_form",
        status: "new",
        score: LeadService.calculateLeadScore(leadData),
        isDuplicate,
        duplicateOf,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        country: leadData.country,
        city: leadData.city,
        state: leadData.state,
        zipCode: leadData.zipCode,
        company: leadData.company,
        productInterest: leadData.productInterest,
        customFields: leadData.customFields || {},
        tags: leadData.tags || [],
        notes: leadData.notes,
      });

      // Log activity
      await LeadActivity.create({
        tenantId,
        leadId: newLead._id,
        action: "created",
        description: `New lead created from ${website.name} (${website.category})`,
        newValue: newLead,
        performedByName: "System",
        metadata: {
          ipAddress: metadata.ipAddress,
          source: website.category,
        },
      });

      // Update website stats
      await Website.findOneAndUpdate({ _id: websiteId, tenantId }, {
        $inc: {
          "stats.totalLeads": 1,
          "stats.leadsThisMonth": 1,
          ...(isDuplicate ? { "stats.duplicatesDetected": 1 } : {}),
        },
        "stats.lastLeadAt": new Date(),
      });

      // Auto-assign lead if not duplicate
      if (!isDuplicate) {
        try {
          await AssignmentService.assignLeadRoundRobin(newLead._id, tenantId, [
            "marketing",
            "user",
          ]);
        } catch (error) {
          logger.warn(
            `Auto-assignment failed for lead ${newLead._id}: ${error.message}`,
          );
          // Don't fail lead creation if assignment fails
        }
      }

      logger.info(
        `Lead created: ${newLead._id} from ${website.name}${isDuplicate ? " (marked as duplicate)" : ""}`,
      );

      return {
        success: true,
        leadId: newLead._id,
        isDuplicate,
        duplicateOf,
        message: isDuplicate
          ? "Duplicate lead detected and logged"
          : "Lead created successfully",
      };
    } catch (error) {
      logger.error(`Error creating lead: ${error.message}`);
      throw error;
    }
  }

  /**
   * Calculate lead score based on data completeness and engagement signals
   * @param {Object} leadData - Lead information
   * @returns {Number} Lead score (0-100)
   */
  static calculateLeadScore(leadData) {
    let score = 0;

    // Data completeness
    if (leadData.firstName) score += 10;
    if (leadData.lastName) score += 5;
    if (leadData.email) score += 15;
    if (leadData.phone) score += 15;
    if (leadData.company) score += 10;
    if (leadData.country) score += 5;
    if (leadData.productInterest) score += 15;
    if (leadData.message?.length > 50) score += 10; // Detailed message
    if (leadData.customFields && Object.keys(leadData.customFields).length > 0)
      score += 5;

    return Math.min(score, 100);
  }

  /**
   * Get leads with filters and pagination
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Object} filters - Filter criteria
   * @param {Number} page - Page number
   * @param {Number} limit - Results per page
   * @returns {Promise<Object>} Paginated leads
   */
  static async getLeads(tenantId, filters = {}, page = 1, limit = 20) {
    try {
      const query = { tenantId };

      // Apply filters
      if (filters.status) query.status = filters.status;
      if (filters.websiteId) query.websiteId = filters.websiteId;
      if (filters.assignedTo && filters.assignedTo !== "null") {
        query.assignedTo = filters.assignedTo;
      }
      if (filters.source) query.source = filters.source;
      if (filters.isDuplicate !== undefined)
        query.isDuplicate = filters.isDuplicate;
      if (filters.unassigned || filters.assignedTo === "null") {
        query.assignedTo = null;
      }
      if (filters.search) {
        const safeSearch = buildSafeSearch(filters.search);
        if (safeSearch) {
          query.$or = [
            { email: safeSearch },
            { fullName: safeSearch },
            { phone: safeSearch },
          ];
        }
      }

      // Date range filters
      if (filters.dateFrom || filters.dateTo) {
        query.createdAt = {};
        if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
      }

      // Calculate pagination
      const skip = (page - 1) * limit;

      // Execute query
      const [leads, total] = await Promise.all([
        Lead.find(query)
          .populate("assignedTo", "name email")
          .populate("websiteId", "name domain")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Lead.countDocuments(query),
      ]);

      return {
        leads,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error(`Error fetching leads: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update lead status
   * @param {ObjectId} leadId - Lead ID
   * @param {String} newStatus - New status
   * @param {ObjectId} tenantId - Tenant ID
   * @param {ObjectId} userId - User making update
   * @returns {Promise<Object>} Updated lead
   */
  static async updateLeadStatus(leadId, newStatus, tenantId, userId) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      const lead = await Lead.findOne({ _id: leadId, tenantId });

      if (!lead) {
        throw new Error("Lead not found");
      }

      const oldStatus = lead.status;

      // Special handling for "converted" status
      const updateData = { status: newStatus };
      if (newStatus === "converted") {
        updateData.convertedAt = new Date();
      }

      const updatedLead = await Lead.findOneAndUpdate(
        { _id: leadId, tenantId },
        updateData,
        { new: true },
      );

      // Log activity
      await LeadActivity.create({
        tenantId,
        leadId,
        action: "status_changed",
        description: `Lead status changed from ${oldStatus} to ${newStatus}`,
        previousValue: { status: oldStatus },
        newValue: { status: newStatus },
        performedBy: userId,
      });

      return updatedLead;
    } catch (error) {
      logger.error(`Error updating lead status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get lead analytics
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Object} filters - Filter by date range, source etc
   * @returns {Promise<Object>} Analytics data
   */
  static async getLeadAnalytics(tenantId, filters = {}) {
    try {
      const matchStage = {
        tenantId: new mongoose.Types.ObjectId(tenantId),
      };

      if (filters.dateFrom || filters.dateTo) {
        matchStage.createdAt = {};
        if (filters.dateFrom)
          matchStage.createdAt.$gte = new Date(filters.dateFrom);
        if (filters.dateTo)
          matchStage.createdAt.$lte = new Date(filters.dateTo);
      }

      const analytics = await Lead.aggregate([
        { $match: matchStage },
        {
          $facet: {
            byStatus: [
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ],
            bySource: [
              {
                $group: {
                  _id: "$source",
                  count: { $sum: 1 },
                },
              },
            ],
            byWebsite: [
              {
                $group: {
                  _id: "$websiteId",
                  count: { $sum: 1 },
                },
              },
            ],
            conversionMetrics: [
              {
                $group: {
                  _id: null,
                  totalLeads: { $sum: 1 },
                  converted: {
                    $sum: { $cond: ["$convertedAt", 1, 0] },
                  },
                  conversionRate: {
                    $avg: { $cond: ["$convertedAt", 1, 0] },
                  },
                  avgScore: { $avg: "$score" },
                },
              },
            ],
            unassignedCount: [
              {
                $match: {
                  $or: [
                    { assignedTo: null },
                    { assignedTo: null },
                  ],
                },
              },
              { $count: "count" },
            ],
          },
        },
      ]);

      return analytics[0];
    } catch (error) {
      logger.error(`Error fetching lead analytics: ${error.message}`);
      throw error;
    }
  }
}

export default LeadService;
