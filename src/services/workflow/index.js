/**
 * Workflow v2 service surface.
 *
 * Re-exports the action registry and compile step so callers can do
 * `import { compileWorkflow, getRegistryEntry } from "../services/workflow"`
 * without having to reach into the file layout.
 */

export {
  getRegistryEntry,
  hasSubtype,
  listSubtypes,
  getEntriesByType,
  getEntriesByCategory,
  validateNodeConfig,
} from "./actionRegistry.js";

export { compileWorkflow } from "./compileWorkflow.js";

export { validateConfig } from "./configValidator.js";

export { createRun, advanceRun } from "./orchestrator.js";

export {
  getNodeExecutor,
  hasExecutor,
  listExecutors,
} from "./nodeExecutors.js";

export {
  emitCrmEvent,
  emitCrmEventSync,
  buildTriggerSubtype,
} from "./crmEventBus.js";
