/**
 * Orbinest SaaS Plan Limits and Feature Matrix
 *
 * This is the single source of truth for what each plan tier includes.
 * Every billing-relevant feature gate or limit check must derive from this config.
 *
 * Tier hierarchy (ascending): starter < growth < agency < enterprise
 *
 * Legacy aliases kept for backward compatibility with existing tenant data:
 *   "free"  → treated as "starter"
 *   "pro"   → treated as "growth"
 *
 * Limits use -1 to mean "unlimited".
 */

// ── Tier ordering (used for requirePlanTier comparisons) ─────────────────────
export const PLAN_TIERS = ["starter", "growth", "agency", "enterprise"];

// ── Legacy alias map ──────────────────────────────────────────────────────────
export const PLAN_ALIASES = {
  free: "starter",
  pro: "growth",
};

// ── Per-plan limits and features ─────────────────────────────────────────────
const PLAN_LIMITS = {
  starter: {
    displayName: "Starter",
    description: "For freelancers and local businesses getting started.",
    limits: {
      maxUsers: 3,
      maxBrands: 1,
      maxContacts: 250,
      maxWorkflowsActive: 3,
      maxWorkflowRunsPerMonth: 100,
      maxAiRunsPerMonth: 50,
      maxMessagesPerMonth: 500,
      maxSocialPostsPerMonth: 10,
      maxReviewRepliesPerMonth: 10,
      maxConnectedChannels: 1,
      maxStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    },
    features: {
      // CRM
      crmBasic: true,
      crmAdvanced: false,
      leads: true,
      contacts: true,
      deals: true,
      activities: true,
      customFields: false,
      leadScoring: false,
      duplicateDetection: true,
      exports: true,

      // Inbox / Channels
      emailInbox: true,
      whatsappInbox: false,

      // Integrations
      gmailIntegration: true,
      whatsappIntegration: false,
      metaIntegration: false,
      gmbIntegration: false,

      // Workflow
      workflowBuilder: false,
      workflowAI: false,

      // AI Features
      aiDrafts: true,
      aiLeadScoring: false,
      aiReviewReply: false,
      aiCustomerSupport: false,
      aiSocialContent: false,
      aiAnalytics: false,

      // Social / Reviews
      socialScheduler: false,
      reviewManagement: false,
      approvalQueue: false,

      // Analytics
      analyticsBasic: true,
      analyticsAdvanced: false,

      // Platform
      apiAccess: false,
      auditLogs: false,
      customLimits: false,
      whiteLabel: false,
      clientWorkspaces: false,
      advancedRbac: false,
      ssoReady: false,
      dedicatedSupport: false,
    },
  },

  growth: {
    displayName: "Growth",
    description: "For startups and growing teams scaling their operations.",
    limits: {
      maxUsers: 15,
      maxBrands: 5,
      maxContacts: 2500,
      maxWorkflowsActive: 20,
      maxWorkflowRunsPerMonth: 1000,
      maxAiRunsPerMonth: 500,
      maxMessagesPerMonth: 5000,
      maxSocialPostsPerMonth: 50,
      maxReviewRepliesPerMonth: 50,
      maxConnectedChannels: 5,
      maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    },
    features: {
      // CRM
      crmBasic: true,
      crmAdvanced: true,
      leads: true,
      contacts: true,
      deals: true,
      activities: true,
      customFields: true,
      leadScoring: true,
      duplicateDetection: true,
      exports: true,

      // Inbox / Channels
      emailInbox: true,
      whatsappInbox: true,

      // Integrations
      gmailIntegration: true,
      whatsappIntegration: true,
      metaIntegration: true,
      gmbIntegration: true,

      // Workflow
      workflowBuilder: true,
      workflowAI: true,

      // AI Features
      aiDrafts: true,
      aiLeadScoring: true,
      aiReviewReply: true,
      aiCustomerSupport: false,
      aiSocialContent: false,
      aiAnalytics: false,

      // Social / Reviews
      socialScheduler: true,
      reviewManagement: true,
      approvalQueue: true,

      // Analytics
      analyticsBasic: true,
      analyticsAdvanced: true,

      // Platform
      apiAccess: true,
      auditLogs: false,
      customLimits: false,
      whiteLabel: false,
      clientWorkspaces: false,
      advancedRbac: false,
      ssoReady: false,
      dedicatedSupport: false,
    },
  },

  agency: {
    displayName: "Agency",
    description:
      "For marketing agencies managing multiple client workspaces.",
    limits: {
      maxUsers: 50,
      maxBrands: -1, // unlimited
      maxContacts: 25000,
      maxWorkflowsActive: 100,
      maxWorkflowRunsPerMonth: 10000,
      maxAiRunsPerMonth: 2000,
      maxMessagesPerMonth: 50000,
      maxSocialPostsPerMonth: 200,
      maxReviewRepliesPerMonth: 200,
      maxConnectedChannels: 20,
      maxStorageBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    },
    features: {
      // CRM
      crmBasic: true,
      crmAdvanced: true,
      leads: true,
      contacts: true,
      deals: true,
      activities: true,
      customFields: true,
      leadScoring: true,
      duplicateDetection: true,
      exports: true,

      // Inbox / Channels
      emailInbox: true,
      whatsappInbox: true,

      // Integrations
      gmailIntegration: true,
      whatsappIntegration: true,
      metaIntegration: true,
      gmbIntegration: true,

      // Workflow
      workflowBuilder: true,
      workflowAI: true,

      // AI Features
      aiDrafts: true,
      aiLeadScoring: true,
      aiReviewReply: true,
      aiCustomerSupport: true,
      aiSocialContent: true,
      aiAnalytics: true,

      // Social / Reviews
      socialScheduler: true,
      reviewManagement: true,
      approvalQueue: true,

      // Analytics
      analyticsBasic: true,
      analyticsAdvanced: true,

      // Platform
      apiAccess: true,
      auditLogs: true,
      customLimits: false,
      whiteLabel: true,
      clientWorkspaces: true,
      advancedRbac: true,
      ssoReady: false,
      dedicatedSupport: false,
    },
  },

  enterprise: {
    displayName: "Enterprise",
    description:
      "For multi-location teams and organizations needing custom SLAs and dedicated infrastructure.",
    limits: {
      maxUsers: -1,
      maxBrands: -1,
      maxContacts: -1,
      maxWorkflowsActive: -1,
      maxWorkflowRunsPerMonth: -1,
      maxAiRunsPerMonth: -1,
      maxMessagesPerMonth: -1,
      maxSocialPostsPerMonth: -1,
      maxReviewRepliesPerMonth: -1,
      maxConnectedChannels: -1,
      maxStorageBytes: -1,
    },
    features: {
      // CRM
      crmBasic: true,
      crmAdvanced: true,
      leads: true,
      contacts: true,
      deals: true,
      activities: true,
      customFields: true,
      leadScoring: true,
      duplicateDetection: true,
      exports: true,

      // Inbox / Channels
      emailInbox: true,
      whatsappInbox: true,

      // Integrations
      gmailIntegration: true,
      whatsappIntegration: true,
      metaIntegration: true,
      gmbIntegration: true,

      // Workflow
      workflowBuilder: true,
      workflowAI: true,

      // AI Features
      aiDrafts: true,
      aiLeadScoring: true,
      aiReviewReply: true,
      aiCustomerSupport: true,
      aiSocialContent: true,
      aiAnalytics: true,

      // Social / Reviews
      socialScheduler: true,
      reviewManagement: true,
      approvalQueue: true,

      // Analytics
      analyticsBasic: true,
      analyticsAdvanced: true,

      // Platform
      apiAccess: true,
      auditLogs: true,
      customLimits: true,
      whiteLabel: true,
      clientWorkspaces: true,
      advancedRbac: true,
      ssoReady: true,
      dedicatedSupport: true,
    },
  },
};

export default PLAN_LIMITS;
