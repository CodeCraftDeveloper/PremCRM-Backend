/**
 * Workflow Action Registry (P3-002).
 *
 * Code-level catalog of every trigger, condition, action, AI, approval,
 * delay, and branch subtype that the v2 workflow engine recognises. The
 * registry is the source of truth for:
 *
 *   - Whether a `Workflow.nodes[].subtype` is valid (compileWorkflow).
 *   - What `node.config` shape that subtype requires.
 *   - Which BullMQ queue the engine dispatches the node to (P3-003).
 *   - Plan-feature gates that must pass before the workflow can save/run.
 *   - Whether the node requires human approval before its outbound effect.
 *   - Whether the node is naturally idempotent or needs an idempotency key.
 *
 * Execution wiring is OUT OF SCOPE for this slice — the `executor` and
 * `queue` fields are metadata that P3-003's `workflow.execute` worker will
 * dispatch on. AI and provider-outbound entries are seeded as
 * `status: "preview"` so the compile step accepts them in saved drafts but
 * the engine refuses to execute them until the corresponding domain phase
 * lands its real processor.
 *
 * Subtype namespace conventions live in `models/Workflow.js`. Adding a new
 * subtype is a single entry here — no schema migration required.
 */

import { QUEUE_NAMES } from "../../queue/queueNames.js";
import { validateConfig } from "./configValidator.js";

const STATUSES = Object.freeze(["stable", "preview", "deprecated"]);

const NODE_TYPES_VALID = new Set([
  "trigger",
  "condition",
  "action",
  "ai",
  "approval",
  "delay",
  "branch",
]);

// ── v1 module ↔ trigger event matrix used by the migration mapper ──────
const V1_MODULES = Object.freeze([
  "lead",
  "contact",
  "account",
  "deal",
  "activity",
]);

const V1_TRIGGER_EVENTS = Object.freeze([
  "on_create",
  "on_update",
  "on_stage_change",
  "on_field_change",
  "time_based",
]);

// ── Reusable config field specs ──────────────────────────────────────────
const FIELD_TENANT_OPTIONAL = { type: "objectIdString", required: false };

// ── Registry entries ─────────────────────────────────────────────────────

const triggerEntries = [];

// Cross-product trigger.<module>.<event> entries — emitted by
// `mapAutomationRuleToWorkflowDefinition`. Stable for CRM modules.
for (const module of V1_MODULES) {
  for (const event of V1_TRIGGER_EVENTS) {
    triggerEntries.push({
      subtype: `trigger.${module}.${event}`,
      type: "trigger",
      category: "crm",
      displayName: `${module} ${event.replace(/_/g, " ")}`,
      description: `Fires when a ${module} ${event.replace(/_/g, " ")} event occurs.`,
      configSchema: {
        fields: {
          // For on_field_change we expect at least { field, from?, to? };
          // for time_based we expect { cronExpression }. Kept permissive at
          // registry level — the engine narrows per event when it builds
          // the trigger index in P3-003.
          field: { type: "string", required: false, maxLength: 128 },
          from: { type: "string", required: false, maxLength: 256 },
          to: { type: "string", required: false, maxLength: 256 },
          cronExpression: { type: "string", required: false, maxLength: 100 },
          v1TriggerType: { type: "string", required: false },
          v1TriggerConfig: { type: "object", required: false },
          module: { type: "string", required: false },
        },
      },
      requiresApproval: false,
      idempotent: true,
      planFeature: "workflowBuilder",
      queue: null,
      executor: `trigger.${module}.${event}`,
      status: "stable",
    });
  }
}

// Schedule trigger (cron-driven via BullMQ repeat jobs).
triggerEntries.push({
  subtype: "trigger.schedule.cron",
  type: "trigger",
  category: "schedule",
  displayName: "On schedule",
  description: "Fires on a cron schedule (BullMQ repeat job).",
  configSchema: {
    fields: {
      cronExpression: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
      timezone: { type: "string", required: false, maxLength: 64 },
    },
  },
  requiresApproval: false,
  idempotent: true,
  planFeature: "workflowBuilder",
  queue: null,
  executor: "trigger.schedule.cron",
  status: "stable",
});

// External webhook trigger (Phase 4+ — payload schema becomes free-form).
triggerEntries.push({
  subtype: "trigger.webhook.external",
  type: "trigger",
  category: "integration",
  displayName: "On external webhook",
  description: "Fires when an external service posts to the workflow webhook.",
  configSchema: {
    fields: {
      verificationSecret: { type: "string", required: false, maxLength: 256 },
    },
  },
  requiresApproval: false,
  idempotent: true,
  planFeature: "workflowBuilder",
  queue: null,
  executor: "trigger.webhook.external",
  status: "stable",
});

// Provider inbound triggers — preview until each provider phase lands.
const previewInboundTriggers = [
  {
    subtype: "trigger.gmail.message_received",
    category: "gmail",
    displayName: "On Gmail message received",
    description: "Fires when a watched Gmail mailbox receives a message.",
    planFeature: "gmailIntegration",
  },
  {
    subtype: "trigger.whatsapp.message_received",
    category: "whatsapp",
    displayName: "On WhatsApp message received",
    description: "Fires when a WhatsApp Business Cloud webhook delivers a message.",
    planFeature: "whatsappIntegration",
  },
  {
    subtype: "trigger.gmb.review_received",
    category: "gmb",
    displayName: "On Google review received",
    description: "Fires when a new Google Business Profile review is synced.",
    planFeature: "gmbIntegration",
  },
];

for (const entry of previewInboundTriggers) {
  triggerEntries.push({
    ...entry,
    type: "trigger",
    configSchema: { fields: {} },
    requiresApproval: false,
    idempotent: true,
    queue: null,
    executor: entry.subtype,
    status: "preview",
  });
}

// ── Conditions / approvals / delays / branches ──────────────────────────

const primitiveEntries = [
  {
    subtype: "condition.expression",
    type: "condition",
    category: "logic",
    displayName: "Condition (AND/OR)",
    description:
      "Evaluates a list of field/operator/value conditions joined by combinator.",
    configSchema: {
      fields: {
        combinator: {
          type: "enum",
          values: ["AND", "OR"],
          required: true,
        },
        conditions: {
          type: "array",
          required: true,
          minItems: 1,
          maxItems: 50,
          of: {
            type: "object",
            fields: {
              field: { type: "string", required: true, maxLength: 128 },
              operator: {
                type: "enum",
                required: true,
                values: [
                  "equals",
                  "not_equals",
                  "contains",
                  "not_contains",
                  "greater_than",
                  "less_than",
                  "is_empty",
                  "is_not_empty",
                  "in",
                  "not_in",
                ],
              },
              // value is optional for is_empty/is_not_empty operators.
            },
          },
        },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "workflowBuilder",
    queue: null,
    executor: "condition.expression",
    status: "stable",
  },
  {
    subtype: "approval.request",
    type: "approval",
    category: "approval",
    displayName: "Wait for approval",
    description:
      "Pauses the run until a human approves or rejects via the approval queue.",
    configSchema: {
      fields: {
        approverRole: {
          type: "enum",
          required: false,
          values: ["admin", "owner", "manager", "any"],
        },
        approverUserId: FIELD_TENANT_OPTIONAL,
        message: { type: "string", required: false, maxLength: 1000 },
        timeoutHours: { type: "number", required: false, min: 0, max: 720 },
        onTimeout: {
          type: "enum",
          required: false,
          values: ["fail", "approve", "reject"],
        },
      },
    },
    requiresApproval: true,
    idempotent: true,
    planFeature: "approvalQueue",
    queue: null,
    executor: "approval.request",
    status: "stable",
  },
  {
    subtype: "delay.wait",
    type: "delay",
    category: "logic",
    displayName: "Wait",
    description: "Pauses the run for a fixed duration before continuing.",
    configSchema: {
      fields: {
        durationMs: {
          type: "number",
          required: true,
          integer: true,
          min: 0,
          max: 30 * 24 * 60 * 60 * 1000, // 30 days
        },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.WORKFLOW_EXECUTE,
    executor: "delay.wait",
    status: "stable",
  },
  {
    subtype: "branch.switch",
    type: "branch",
    category: "logic",
    displayName: "Switch / branch",
    description:
      "Routes to a labelled outgoing edge based on a switch expression.",
    configSchema: {
      fields: {
        expression: { type: "string", required: true, maxLength: 1024 },
        cases: {
          type: "array",
          required: true,
          minItems: 1,
          maxItems: 50,
          of: {
            type: "object",
            fields: {
              label: { type: "string", required: true, maxLength: 64 },
              value: { type: "string", required: false, maxLength: 256 },
            },
          },
        },
        defaultLabel: { type: "string", required: false, maxLength: 64 },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "workflowBuilder",
    queue: null,
    executor: "branch.switch",
    status: "stable",
  },
];

// ── Actions ──────────────────────────────────────────────────────────────

const actionEntries = [
  {
    subtype: "action.crm.create_task",
    type: "action",
    category: "crm",
    displayName: "Create CRM task",
    description: "Creates a task on the trigger entity.",
    configSchema: {
      fields: {
        title: { type: "string", required: true, minLength: 1, maxLength: 200 },
        description: { type: "string", required: false, maxLength: 4000 },
        ownerId: FIELD_TENANT_OPTIONAL,
        dueInDays: {
          type: "number",
          required: false,
          integer: true,
          min: 0,
          max: 365,
        },
        priority: {
          type: "enum",
          required: false,
          values: ["low", "medium", "high", "urgent"],
        },
        v1ActionType: { type: "string", required: false },
      },
    },
    requiresApproval: false,
    idempotent: false,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.WORKFLOW_EXECUTE,
    executor: "action.crm.create_task",
    status: "stable",
  },
  {
    subtype: "action.crm.update_field",
    type: "action",
    category: "crm",
    displayName: "Update CRM field",
    description: "Updates a field on the trigger entity.",
    configSchema: {
      fields: {
        field: { type: "string", required: true, minLength: 1, maxLength: 128 },
        // value is intentionally untyped — supports string/number/bool/null.
        v1ActionType: { type: "string", required: false },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.WORKFLOW_EXECUTE,
    executor: "action.crm.update_field",
    status: "stable",
  },
  {
    subtype: "action.crm.assign_owner",
    type: "action",
    category: "crm",
    displayName: "Assign owner",
    description: "Reassigns the trigger entity to a specified user.",
    configSchema: {
      fields: {
        ownerId: { type: "objectIdString", required: false },
        ownerStrategy: {
          type: "enum",
          required: false,
          values: ["specific_user", "round_robin", "least_loaded"],
        },
        v1ActionType: { type: "string", required: false },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.WORKFLOW_EXECUTE,
    executor: "action.crm.assign_owner",
    status: "stable",
  },
  {
    subtype: "action.notification.send",
    type: "action",
    category: "notification",
    displayName: "Send in-app notification",
    description: "Sends an in-app notification to a user or role.",
    configSchema: {
      fields: {
        recipientUserId: { type: "objectIdString", required: false },
        recipientRole: {
          type: "enum",
          required: false,
          values: ["admin", "owner", "manager", "any"],
        },
        title: { type: "string", required: true, minLength: 1, maxLength: 200 },
        body: { type: "string", required: false, maxLength: 2000 },
        v1ActionType: { type: "string", required: false },
      },
    },
    requiresApproval: false,
    idempotent: false,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.NOTIFICATIONS_SEND,
    executor: "action.notification.send",
    status: "stable",
  },
  {
    subtype: "action.webhook.call",
    type: "action",
    category: "integration",
    displayName: "Call webhook",
    description: "Issues an HTTP request to an external endpoint.",
    configSchema: {
      fields: {
        url: { type: "string", required: true, minLength: 1, maxLength: 2048 },
        method: {
          type: "enum",
          required: false,
          values: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        },
        headers: { type: "object", required: false },
        // body intentionally untyped — supports JSON object/string/null.
        timeoutMs: {
          type: "number",
          required: false,
          integer: true,
          min: 1000,
          max: 60000,
        },
        v1ActionType: { type: "string", required: false },
      },
    },
    requiresApproval: false,
    idempotent: false,
    planFeature: "workflowBuilder",
    queue: QUEUE_NAMES.WORKFLOW_EXECUTE,
    executor: "action.webhook.call",
    status: "stable",
  },
];

// Outbound provider actions — preview until each provider phase lands.
// Compile-time accept saves drafts; engine refuses to execute "preview"
// until the corresponding processor is registered (P3-003+).
const previewOutboundActions = [
  {
    subtype: "action.gmail.send",
    category: "gmail",
    displayName: "Send Gmail (approved)",
    description: "Sends a Gmail message after human approval.",
    planFeature: "gmailIntegration",
    queue: QUEUE_NAMES.GMAIL_SYNC,
  },
  {
    subtype: "action.whatsapp.send",
    category: "whatsapp",
    displayName: "Send WhatsApp message (approved)",
    description: "Sends a WhatsApp Cloud API message after human approval.",
    planFeature: "whatsappIntegration",
    queue: QUEUE_NAMES.WHATSAPP_MESSAGES,
  },
  {
    subtype: "action.meta.publish",
    category: "meta",
    displayName: "Publish to Facebook/Instagram (approved)",
    description: "Publishes a Meta post after human approval.",
    planFeature: "metaIntegration",
    queue: QUEUE_NAMES.META_SOCIAL_PUBLISH,
  },
  {
    subtype: "action.gmb.reply",
    category: "gmb",
    displayName: "Reply to Google review (approved)",
    description: "Posts a reply to a Google Business Profile review after human approval.",
    planFeature: "gmbIntegration",
    queue: QUEUE_NAMES.GMB_REVIEWS,
  },
];

for (const entry of previewOutboundActions) {
  actionEntries.push({
    ...entry,
    type: "action",
    configSchema: { fields: {} },
    requiresApproval: true,
    idempotent: false,
    executor: entry.subtype,
    status: "preview",
  });
}

// ── AI placeholder entries (Phase 7) ────────────────────────────────────

const aiEntries = [
  {
    subtype: "ai.draft.email",
    type: "ai",
    category: "ai",
    displayName: "AI draft email",
    description: "Generates an email draft for human approval.",
    configSchema: {
      fields: {
        promptTemplateId: { type: "string", required: false, maxLength: 128 },
        tone: { type: "string", required: false, maxLength: 64 },
        maxTokens: {
          type: "number",
          required: false,
          integer: true,
          min: 16,
          max: 4096,
        },
      },
    },
    requiresApproval: true,
    idempotent: false,
    planFeature: "aiDrafts",
    queue: QUEUE_NAMES.AI_DRAFT,
    executor: "ai.draft.email",
    status: "preview",
  },
  {
    subtype: "ai.draft.reply",
    type: "ai",
    category: "ai",
    displayName: "AI draft reply",
    description: "Generates a reply draft for the trigger conversation.",
    configSchema: {
      fields: {
        promptTemplateId: { type: "string", required: false, maxLength: 128 },
        channel: {
          type: "enum",
          required: false,
          values: ["gmail", "whatsapp", "gmb", "meta"],
        },
      },
    },
    requiresApproval: true,
    idempotent: false,
    planFeature: "aiDrafts",
    queue: QUEUE_NAMES.AI_DRAFT,
    executor: "ai.draft.reply",
    status: "preview",
  },
  {
    subtype: "ai.classify.lead_quality",
    type: "ai",
    category: "ai",
    displayName: "AI classify lead quality",
    description: "Classifies a lead as cold/warm/hot with confidence.",
    configSchema: {
      fields: {
        promptTemplateId: { type: "string", required: false, maxLength: 128 },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "aiLeadScoring",
    queue: QUEUE_NAMES.AI_CLASSIFY,
    executor: "ai.classify.lead_quality",
    status: "preview",
  },
  {
    subtype: "ai.classify.intent",
    type: "ai",
    category: "ai",
    displayName: "AI classify intent",
    description: "Classifies a customer message intent.",
    configSchema: {
      fields: {
        promptTemplateId: { type: "string", required: false, maxLength: 128 },
      },
    },
    requiresApproval: false,
    idempotent: true,
    planFeature: "aiCustomerSupport",
    queue: QUEUE_NAMES.AI_CLASSIFY,
    executor: "ai.classify.intent",
    status: "preview",
  },
];

// ── Final registry assembly ─────────────────────────────────────────────

const ALL_ENTRIES = [
  ...triggerEntries,
  ...primitiveEntries,
  ...actionEntries,
  ...aiEntries,
];

// Sanity check at module load — duplicate subtype IDs would silently
// shadow each other and break the engine. Throw early.
const REGISTRY = (() => {
  const map = new Map();
  for (const entry of ALL_ENTRIES) {
    if (!entry || !entry.subtype || !entry.type) {
      throw new Error(
        `actionRegistry: invalid entry ${JSON.stringify(entry)} — subtype/type required`,
      );
    }
    if (!NODE_TYPES_VALID.has(entry.type)) {
      throw new Error(
        `actionRegistry: entry "${entry.subtype}" has unknown type "${entry.type}"`,
      );
    }
    if (!STATUSES.includes(entry.status)) {
      throw new Error(
        `actionRegistry: entry "${entry.subtype}" has invalid status "${entry.status}"`,
      );
    }
    if (map.has(entry.subtype)) {
      throw new Error(
        `actionRegistry: duplicate subtype "${entry.subtype}"`,
      );
    }
    map.set(entry.subtype, Object.freeze({ ...entry }));
  }
  return map;
})();

// ── Public API ──────────────────────────────────────────────────────────

/** Look up a registry entry by subtype. Returns undefined when missing. */
export function getRegistryEntry(subtype) {
  if (typeof subtype !== "string") return undefined;
  return REGISTRY.get(subtype);
}

/** True when the subtype is registered. */
export function hasSubtype(subtype) {
  return REGISTRY.has(subtype);
}

/** All registered subtype IDs (sorted). */
export function listSubtypes() {
  return Array.from(REGISTRY.keys()).sort();
}

/** All entries for a given node type (e.g. "action"). */
export function getEntriesByType(nodeType) {
  return Array.from(REGISTRY.values()).filter((e) => e.type === nodeType);
}

/** All entries for a given category (e.g. "crm", "ai"). */
export function getEntriesByCategory(category) {
  return Array.from(REGISTRY.values()).filter((e) => e.category === category);
}

/**
 * Validate a single node's config against its registry entry.
 * Returns { ok, errors } where errors is an array of strings.
 */
export function validateNodeConfig(subtype, config) {
  const entry = getRegistryEntry(subtype);
  if (!entry) {
    return { ok: false, errors: [`unknown subtype "${subtype}"`] };
  }
  const errors = validateConfig(entry.configSchema, config);
  return { ok: errors.length === 0, errors };
}

export const __TEST_ONLY__ = Object.freeze({
  V1_MODULES,
  V1_TRIGGER_EVENTS,
  REGISTRY_SIZE: REGISTRY.size,
});
