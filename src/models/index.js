// Export all models from a single entry point
export { default as User } from "./User.js";
export { default as Event } from "./Event.js";
export { default as Client } from "./Client.js";
export { default as Remark } from "./Remark.js";
export { default as ActivityLog } from "./ActivityLog.js";
export { default as UserSession } from "./UserSession.js";
export { default as Tenant } from "./Tenant.js";
export { default as Invite } from "./Invite.js";
export { default as Website } from "./Website.js";
export { default as Lead } from "./Lead.js";
export { default as LeadActivity } from "./LeadActivity.js";
export { default as LeadRemark } from "./LeadRemark.js";
export { default as AuditLog } from "./AuditLog.js";
export { default as UsageMetric } from "./UsageMetric.js";
export { default as TenantSettings } from "./TenantSettings.js";
export { default as Ticket } from "./Ticket.js";
export { default as TicketRemark } from "./TicketRemark.js";

// CRM domain models
export {
  Contact,
  Account,
  Deal,
  CrmActivity,
  Pipeline,
  AutomationRule,
  WorkflowExecution,
  Blueprint,
  CustomModule,
  CustomField,
  FIELD_TYPES,
  PHASE1_FIELD_TYPES,
  MAX_FIELDS_PER_MODULE,
  ModuleLayout,
  FormDefinition,
} from "./crm/index.js";
