import Lead from "../../models/Lead.js";
import Contact from "../../models/crm/Contact.js";
import Account from "../../models/crm/Account.js";
import Deal from "../../models/crm/Deal.js";
import Pipeline from "../../models/crm/Pipeline.js";
import AuditLog from "../../models/AuditLog.js";
import { ApiError } from "../../utils/apiResponse.js";

/**
 * LeadConversionService — Converts a Lead into Contact + Account + Deal.
 * Prevents double conversion. Atomic-safe via validation.
 */
const LeadConversionService = {
  /**
   * Convert a lead into CRM entities.
   *
   * @param {string} tenantId
   * @param {string} leadId
   * @param {Object} options — { createDeal: true, dealName, dealAmount, pipelineId }
   * @param {Object} user   — req.user enriched with _ipAddress, _userAgent, _requestId
   * @returns {{ contact, account, deal?, lead }}
   */
  async convert(tenantId, leadId, options = {}, user) {
    // ── Fetch lead ──────────────────────────────────────
    const lead = await Lead.findOne({ _id: leadId, tenantId, deletedAt: null });
    if (!lead) throw ApiError.notFound("Lead not found");

    // ── Prevent double conversion ───────────────────────
    if (lead.isConverted) {
      throw ApiError.conflict("Lead has already been converted");
    }

    // ── Create Account ──────────────────────────────────
    const accountData = {
      tenantId,
      name: lead.company || lead.fullName || lead.firstName,
      phone: lead.phone,
      email: lead.email,
      industry: lead.productInterest || undefined,
      ownerId: lead.assignedTo || user._id,
      convertedFromLead: lead._id,
      billingAddress: {
        city: lead.city,
        state: lead.state,
        country: lead.country,
        zipCode: lead.zipCode,
      },
    };
    const account = await Account.create(accountData);

    // ── Create Contact ──────────────────────────────────
    const contactData = {
      tenantId,
      firstName: lead.firstName,
      lastName: lead.lastName || "",
      email: lead.email,
      phone: lead.phone,
      accountId: account._id,
      ownerId: lead.assignedTo || user._id,
      source: "lead_conversion",
      convertedFromLead: lead._id,
      description: lead.message || lead.notes || "",
      address: {
        city: lead.city,
        state: lead.state,
        country: lead.country,
        zipCode: lead.zipCode,
      },
      tags: lead.tags || [],
      customFields: lead.customFields || {},
    };
    const contact = await Contact.create(contactData);

    // ── Optionally create Deal ──────────────────────────
    let deal = null;
    if (options.createDeal !== false) {
      const pipeline = options.pipelineId
        ? await Pipeline.findOne({
            _id: options.pipelineId,
            tenantId,
            isActive: true,
          })
        : await Pipeline.getDefaultForTenant(tenantId);

      if (!pipeline) throw ApiError.badRequest("No pipeline available");

      const firstStage = pipeline.getSortedStages()[0];

      deal = await Deal.create({
        tenantId,
        name: options.dealName || `${lead.fullName || lead.firstName} - Deal`,
        amount: options.dealAmount || lead.conversionValue || 0,
        closingDate: options.closingDate || null,
        pipelineId: pipeline._id,
        stage: firstStage.name,
        probability: firstStage.probability,
        contactId: contact._id,
        accountId: account._id,
        ownerId: lead.assignedTo || user._id,
        source: "lead_conversion",
        convertedFromLead: lead._id,
        stageHistory: [
          { stage: firstStage.name, enteredAt: new Date(), movedBy: user._id },
        ],
      });
    }

    // ── Mark lead as converted ──────────────────────────
    lead.isConverted = true;
    lead.convertedAt = new Date();
    lead.convertedToContactId = contact._id;
    lead.convertedToAccountId = account._id;
    if (deal) lead.convertedToDealId = deal._id;
    lead.status = "closed";
    await lead.save();

    // ── Audit log ───────────────────────────────────────
    AuditLog.record({
      tenantId,
      userId: user._id,
      action: "lead.convert",
      entityType: "lead",
      entityId: lead._id,
      description: `Lead converted: ${lead.fullName || lead.firstName}`,
      metadata: {
        contactId: contact._id,
        accountId: account._id,
        dealId: deal?._id || null,
      },
      ipAddress: user._ipAddress,
      userAgent: user._userAgent,
      requestId: user._requestId,
    });

    return { contact, account, deal, lead };
  },
};

export default LeadConversionService;
