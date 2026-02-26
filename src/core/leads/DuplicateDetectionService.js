import mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import LeadActivity from "../../models/LeadActivity.js";
import logger from "../../utils/logger.js";

/**
 * Service for detecting duplicate leads
 * Can identify duplicates before saving or after
 */
class DuplicateDetectionService {
  /**
   * Find duplicate leads based on email or phone
   * @param {String} email - Lead email
   * @param {String} phone - Lead phone
   * @param {ObjectId} tenantId - Tenant ID
   * @param {ObjectId} websiteId - Website ID
   * @param {Object} settings - Duplicate settings from website
   * @returns {Promise<Array>} Array of potential duplicate leads
   */
  static async findDuplicates(
    email,
    phone,
    tenantId,
    websiteId,
    settings = {},
  ) {
    try {
      const query = { tenantId };
      const filters = [];

      // Check email if enabled
      if (settings.checkEmail !== false && email) {
        filters.push({ email: email.toLowerCase() });
      }

      // Check phone if enabled
      if (settings.checkPhone !== false && phone) {
        filters.push({ phone });
      }

      if (filters.length === 0) {
        return [];
      }

      // Find duplicates (not already marked as duplicate)
      const duplicates = await Lead.find(
        {
          tenantId,
          $or: filters,
          isDuplicate: false,
        },
        "_id email phone fullName websiteId source status",
      ).lean();

      return duplicates;
    } catch (error) {
      logger.error(`Error finding duplicates: ${error.message}`);
      return [];
    }
  }

  /**
   * Mark a lead as duplicate of another
   * @param {ObjectId} duplicateLeadId - Lead to mark as duplicate
   * @param {ObjectId} originalLeadId - Original lead (keep this one)
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} Updated duplicate lead
   */
  static async markAsDuplicate(duplicateLeadId, originalLeadId, metadata = {}) {
    try {
      const duplicateLead = await Lead.findByIdAndUpdate(
        duplicateLeadId,
        {
          isDuplicate: true,
          duplicateOf: originalLeadId,
        },
        { new: true },
      );

      return duplicateLead;
    } catch (error) {
      logger.error(`Error marking lead as duplicate: ${error.message}`);
      throw error;
    }
  }

  /**
   * Merge duplicate leads into one
   * Keeps original, consolidates data from duplicate
   * @param {ObjectId} originalLeadId - Lead to keep
   * @param {ObjectId} duplicateLeadId - Lead to merge from
   * @param {ObjectId} tenantId - Tenant ID
   * @param {ObjectId} userId - User performing merge
   * @returns {Promise<Object>} Merged lead
   */
  static async mergeDuplicates(
    originalLeadId,
    duplicateLeadId,
    tenantId,
    userId,
  ) {
    try {
      const originalLead = await Lead.findById(originalLeadId);
      const duplicateLead = await Lead.findById(duplicateLeadId);

      if (!originalLead || !duplicateLead) {
        throw new Error("One or both leads not found");
      }

      // Consolidate data (prefer non-empty fields from original, fill gaps from duplicate)
      const mergedData = {
        phone: originalLead.phone || duplicateLead.phone,
        firstName: originalLead.firstName || duplicateLead.firstName,
        lastName: originalLead.lastName || duplicateLead.lastName,
        fullName: originalLead.fullName || duplicateLead.fullName,
        message: originalLead.message || duplicateLead.message,
        country: originalLead.country || duplicateLead.country,
        city: originalLead.city || duplicateLead.city,
        state: originalLead.state || duplicateLead.state,
        zipCode: originalLead.zipCode || duplicateLead.zipCode,
        company: originalLead.company || duplicateLead.company,
        productInterest:
          originalLead.productInterest || duplicateLead.productInterest,
        // Merge tags
        tags: Array.from(
          new Set([...originalLead.tags, ...duplicateLead.tags]),
        ),
        // Merge notes
        notes:
          `${originalLead.notes || ""}\n\n[Merged from duplicate ${duplicateLeadId}]:\n${duplicateLead.notes || ""}`.trim(),
        // Add to merge history
        mergeDuplicates: [...originalLead.mergeDuplicates, duplicateLeadId],
      };

      // Update original lead with merged data
      const updatedLead = await Lead.findByIdAndUpdate(
        originalLeadId,
        mergedData,
        { new: true },
      );

      // Mark duplicate as merged
      await Lead.findByIdAndUpdate(duplicateLeadId, {
        isDuplicate: true,
        duplicateOf: originalLeadId,
      });

      // Log activity
      await LeadActivity.create({
        tenantId,
        leadId: originalLeadId,
        action: "merged",
        description: `Lead ${duplicateLeadId} merged into this lead`,
        newValue: mergedData,
        performedBy: userId,
        relatedLeadId: duplicateLeadId,
      });

      logger.info(
        `Leads merged: ${duplicateLeadId} merged into ${originalLeadId}`,
      );

      return updatedLead;
    } catch (error) {
      logger.error(`Error merging duplicates: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find/create duplicate groups (leads with same email or phone)
   * Returns groups of related leads for batch operations
   * @param {ObjectId} tenantId - Tenant ID
   * @returns {Promise<Array>} Array of duplicate groups
   */
  static async findDuplicateGroups(tenantId) {
    try {
      const duplicateGroups = await Lead.aggregate([
        {
          $match: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            isDuplicate: false,
            $or: [{ email: { $exists: true, $ne: null } }],
          },
        },
        {
          $group: {
            _id: "$email",
            leads: {
              $push: {
                _id: "$_id",
                fullName: "$fullName",
                phone: "$phone",
                source: "$source",
                createdAt: "$createdAt",
              },
            },
            count: { $sum: 1 },
          },
        },
        {
          $match: { count: { $gt: 1 } },
        },
        {
          $sort: { count: -1 },
        },
      ]);

      return duplicateGroups;
    } catch (error) {
      logger.error(`Error finding duplicate groups: ${error.message}`);
      return [];
    }
  }

  /**
   * Get similarity score between two leads (0-100)
   * @param {Object} lead1 - First lead
   * @param {Object} lead2 - Second lead
   * @returns {Number} Similarity score
   */
  static calculateSimilarity(lead1, lead2) {
    let score = 0;

    // Email match
    if (
      lead1.email &&
      lead2.email &&
      lead1.email.toLowerCase() === lead2.email.toLowerCase()
    ) {
      score += 40;
    }

    // Phone match
    if (lead1.phone && lead2.phone && lead1.phone === lead2.phone) {
      score += 40;
    }

    // Name match (fuzzy)
    if (
      lead1.fullName &&
      lead2.fullName &&
      lead1.fullName.toLowerCase() === lead2.fullName.toLowerCase()
    ) {
      score += 15;
    }

    // Company match
    if (
      lead1.company &&
      lead2.company &&
      lead1.company.toLowerCase() === lead2.company.toLowerCase()
    ) {
      score += 5;
    }

    return Math.min(score, 100);
  }
}

export default DuplicateDetectionService;
