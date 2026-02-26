import mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import User from "../../models/User.js";
import LeadActivity from "../../models/LeadActivity.js";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";

/**
 * Service for intelligent lead assignment
 * Supports round-robin, least-loaded, and rule-based assignment
 */
class AssignmentService {
  /**
   * Assign lead using round-robin algorithm
   * Distributes leads evenly across active sales team members
   * @param {ObjectId} leadId - Lead to assign
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Array} roleFilter - Roles to assign to (e.g., ['marketing', 'user'])
   * @returns {Promise<Object>} Assignment result {leadId, assignedTo, assignedAt}
   */
  static async assignLeadRoundRobin(
    leadId,
    tenantId,
    roleFilter = ["marketing"], // Default marketing role
  ) {
    try {
      // Get active sales team members
      const salesTeam = await User.find(
        {
          tenantId,
          role: { $in: roleFilter },
          isActive: true,
        },
        "_id name email",
      );

      if (salesTeam.length === 0) {
        logger.warn(
          `No active sales team members found for round-robin assignment`,
        );
        return null;
      }

      // Get current round-robin index from Redis
      const roundRobinKey = `assignment:round_robin:${tenantId}`;
      let currentIndex = await redis.get(roundRobinKey);
      currentIndex = currentIndex ? parseInt(currentIndex) : 0;

      // Get next user (cycle through list)
      const nextIndex = currentIndex % salesTeam.length;
      const nextUser = salesTeam[nextIndex];

      // Update round-robin counter
      await redis.set(roundRobinKey, (nextIndex + 1) % salesTeam.length);

      // Assign lead
      const assignmentResult = await this.assignLeadToUser(
        leadId,
        nextUser._id,
        tenantId,
        "round_robin",
      );

      logger.info(
        `Lead ${leadId} assigned to ${nextUser.name} via round-robin`,
      );

      return assignmentResult;
    } catch (error) {
      logger.error(`Round-robin assignment error: ${error.message}`);
      return null;
    }
  }

  /**
   * Assign lead to least-loaded team member
   * Distributes based on current lead count
   * @param {ObjectId} leadId - Lead to assign
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Array} roleFilter - Roles to assign to
   * @returns {Promise<Object>} Assignment result
   */
  static async assignLeadLeastLoaded(
    leadId,
    tenantId,
    roleFilter = ["marketing"],
  ) {
    try {
      // Get active team members with current lead counts
      const teamLeadCounts = await Lead.aggregate([
        {
          $match: {
            tenantId,
            assignedTo: { $exists: true, $ne: null },
            status: { $ne: "closed" },
          },
        },
        {
          $group: {
            _id: "$assignedTo",
            count: { $sum: 1 },
          },
        },
      ]);

      // Get all active sales team
      const salesTeam = await User.find(
        {
          tenantId,
          role: { $in: roleFilter },
          isActive: true,
        },
        "_id name email",
      );

      if (salesTeam.length === 0) {
        logger.warn(
          `No active sales team members found for least-loaded assignment`,
        );
        return null;
      }

      // Create map of lead counts
      const leadCountMap = {};
      teamLeadCounts.forEach((item) => {
        leadCountMap[item._id.toString()] = item.count;
      });

      // Find team member with least leads
      let leastLoadedUser = salesTeam[0];
      let minLeads = leadCountMap[salesTeam[0]._id.toString()] || 0;

      for (const user of salesTeam) {
        const leadCount = leadCountMap[user._id.toString()] || 0;
        if (leadCount < minLeads) {
          leastLoadedUser = user;
          minLeads = leadCount;
        }
      }

      // Assign lead
      const assignmentResult = await this.assignLeadToUser(
        leadId,
        leastLoadedUser._id,
        tenantId,
        "least_loaded",
      );

      logger.info(
        `Lead ${leadId} assigned to ${leastLoadedUser.name} (${minLeads} existing leads)`,
      );

      return assignmentResult;
    } catch (error) {
      logger.error(`Least-loaded assignment error: ${error.message}`);
      return null;
    }
  }

  /**
   * Assign lead based on custom rules (location, company, source, etc.)
   * @param {Object} lead - Lead object with data
   * @param {ObjectId} tenantId - Tenant ID
   * @param {Array} rules - Assignment rules
   * @returns {Promise<Object>} Assignment result
   */
  static async assignLeadByRules(lead, tenantId, rules) {
    try {
      let selectedUser = null;

      // Evaluate rules in order
      for (const rule of rules) {
        const { condition, userId, priority } = rule;

        // Evaluate condition (simplified - can be expanded)
        let matches = false;

        if (condition.field === "source" && condition.equals) {
          matches = lead.source === condition.equals;
        } else if (condition.field === "country" && condition.equals) {
          matches = lead.country === condition.equals;
        } else if (condition.field === "company" && condition.contains) {
          matches = lead.company?.includes(condition.contains);
        }

        if (matches) {
          selectedUser = userId;
          break; // First matching rule wins
        }
      }

      if (!selectedUser) {
        // Fallback to round-robin if no rule matches
        const result = await this.assignLeadRoundRobin(lead._id, tenantId);
        return result;
      }

      // Assign to selected user
      const assignmentResult = await this.assignLeadToUser(
        lead._id,
        selectedUser,
        tenantId,
        "rule_based",
      );

      logger.info(`Lead ${lead._id} assigned via rules`);

      return assignmentResult;
    } catch (error) {
      logger.error(`Rule-based assignment error: ${error.message}`);
      return null;
    }
  }

  /**
   * Assign lead to specific user
   * @param {ObjectId} leadId - Lead to assign
   * @param {ObjectId} userId - User to assign to
   * @param {ObjectId} tenantId - Tenant ID
   * @param {String} method - Assignment method for logging
   * @returns {Promise<Object>} Assignment result
   */
  static async assignLeadToUser(leadId, userId, tenantId, method = "manual") {
    try {
      // Get lead and user
      const [lead, user] = await Promise.all([
        Lead.findById(leadId),
        User.findById(userId, "_id name email"),
      ]);

      if (!lead || !user) {
        throw new Error("Lead or user not found");
      }

      // If already assigned to someone, add to previous assignments
      const previousAssignments = lead.previousAssignments || [];
      if (lead.assignedTo) {
        previousAssignments.push({
          userId: lead.assignedTo,
          assignedAt: lead.assignedAt,
          assignmentDuration: Math.floor(
            (Date.now() - lead.assignedAt) / (1000 * 60),
          ), // minutes
        });
      }

      // Update lead
      const updatedLead = await Lead.findByIdAndUpdate(
        leadId,
        {
          assignedTo: userId,
          assignedAt: new Date(),
          previousAssignments,
          lastActivityAt: new Date(),
        },
        { new: true },
      );

      // Log activity
      await LeadActivity.create({
        tenantId,
        leadId,
        action: lead.assignedTo ? "reassigned" : "assigned",
        description: `Lead assigned to ${user.name} (${method})`,
        newValue: { assignedTo: userId, assignedAt: new Date() },
        performedByName: "System",
      });

      return {
        leadId,
        assignedTo: userId,
        assignedToName: user.name,
        assignedAt: new Date(),
        method,
      };
    } catch (error) {
      logger.error(`Error assigning lead to user: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get assignment statistics for a team member
   * @param {ObjectId} userId - User to get stats for
   * @param {ObjectId} tenantId - Tenant ID
   * @returns {Promise<Object>} Assignment statistics
   */
  static async getAssignmentStats(userId, tenantId) {
    try {
      const stats = await Lead.aggregate([
        {
          $match: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            assignedTo: new mongoose.Types.ObjectId(userId),
          },
        },
        {
          $facet: {
            total: [{ $count: "count" }],
            byStatus: [
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ],
            converted: [
              {
                $match: { convertedAt: { $exists: true, $ne: null } },
              },
              {
                $count: "count",
              },
            ],
            avgScore: [
              {
                $group: {
                  _id: null,
                  avgScore: { $avg: "$score" },
                },
              },
            ],
          },
        },
      ]);

      return {
        totalLeads: stats[0].total[0]?.count || 0,
        byStatus: stats[0].byStatus,
        converted: stats[0].converted[0]?.count || 0,
        avgScore: stats[0].avgScore[0]?.avgScore || 0,
      };
    } catch (error) {
      logger.error(`Error getting assignment stats: ${error.message}`);
      return null;
    }
  }

  /**
   * Get unassigned leads count
   * @param {ObjectId} tenantId - Tenant ID
   * @returns {Promise<Number>} Count of unassigned leads
   */
  static async getUnassignedLeadsCount(tenantId) {
    try {
      const count = await Lead.countDocuments({
        tenantId,
        assignedTo: { $exists: false },
      });

      return count;
    } catch (error) {
      logger.error(`Error getting unassigned leads count: ${error.message}`);
      return 0;
    }
  }

  /**
   * Auto-assign all unassigned leads
   * @param {ObjectId} tenantId - Tenant ID
   * @param {String} method - Assignment method (round_robin, least_loaded)
   * @returns {Promise<Object>} Assignment summary
   */
  static async autoAssignAllUnassigned(tenantId, method = "round_robin") {
    try {
      const unassigned = await Lead.find({
        tenantId,
        assignedTo: { $exists: false },
      });

      let assigned = 0;
      let failed = 0;

      for (const lead of unassigned) {
        try {
          let result;
          if (method === "least_loaded") {
            result = await this.assignLeadLeastLoaded(lead._id, tenantId);
          } else {
            result = await this.assignLeadRoundRobin(lead._id, tenantId);
          }

          if (result) {
            assigned++;
          }
        } catch (error) {
          failed++;
          logger.error(`Failed to assign lead ${lead._id}: ${error.message}`);
        }
      }

      logger.info(
        `Auto-assignment complete: ${assigned} assigned, ${failed} failed`,
      );

      return {
        totalUnassigned: unassigned.length,
        assigned,
        failed,
        method,
      };
    } catch (error) {
      logger.error(`Error auto-assigning leads: ${error.message}`);
      throw error;
    }
  }
}

export default AssignmentService;
