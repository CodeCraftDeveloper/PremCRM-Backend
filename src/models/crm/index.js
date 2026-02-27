// CRM domain models — single entry point
export { default as Contact } from "./Contact.js";
export { default as Account } from "./Account.js";
export { default as Deal } from "./Deal.js";
export { default as CrmActivity } from "./CrmActivity.js";
export { default as Pipeline } from "./Pipeline.js";
export { default as AutomationRule } from "./AutomationRule.js";
export { default as WorkflowExecution } from "./WorkflowExecution.js";
export { default as Blueprint } from "./Blueprint.js";

// Dynamic Metadata Engine models
export { default as CustomModule } from "./CustomModule.js";
export {
  default as CustomField,
  FIELD_TYPES,
  PHASE1_FIELD_TYPES,
  MAX_FIELDS_PER_MODULE,
} from "./CustomField.js";
export { default as ModuleLayout } from "./ModuleLayout.js";
export { default as FormDefinition } from "./FormDefinition.js";
