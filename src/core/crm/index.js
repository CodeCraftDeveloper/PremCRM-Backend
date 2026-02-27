// CRM core services — single entry point
export { default as ContactService } from "./ContactService.js";
export { default as AccountService } from "./AccountService.js";
export { default as DealService } from "./DealService.js";
export { default as CrmActivityService } from "./CrmActivityService.js";
export { default as PipelineService } from "./PipelineService.js";
export { default as LeadConversionService } from "./LeadConversionService.js";
export { default as WorkflowEngine } from "./WorkflowEngine.js";
export { default as BlueprintService } from "./BlueprintService.js";
export { default as CrmAnalyticsService } from "./CrmAnalyticsService.js";

// Dynamic Metadata Engine services
export { default as CustomModuleService } from "./CustomModuleService.js";
export { default as CustomFieldService } from "./CustomFieldService.js";
export { default as LayoutService } from "./LayoutService.js";
export { default as DynamicFormService } from "./DynamicFormService.js";
export {
  processCustomData,
  resolveRecordReferences,
  resolveListReferences,
} from "./customDataHelper.js";

// Hardening utilities (Phase 1.1)
export { default as customFieldCache } from "./CustomFieldCache.js";
export {
  buildSafeCustomFilter,
  checkReferenceDepth,
  startTimer,
  THRESHOLDS,
  MAX_FILTER_CONDITIONS,
  MAX_REFERENCE_DEPTH,
} from "./customFieldPerf.js";
