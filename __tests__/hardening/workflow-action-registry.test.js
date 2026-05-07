/**
 * Tests for the P3-002 Workflow Action Registry:
 *   1. Registry shape — every entry has the contract fields, subtype IDs
 *      are unique, the cross-product of v1 modules × v1 trigger events is
 *      seeded so the migration mapper output round-trips.
 *   2. compileWorkflow — accepts valid graphs, rejects unknown subtypes,
 *      rejects type/subtype mismatches, rejects missing-required config,
 *      rejects edges to unknown nodes, surfaces preview-status warnings,
 *      and validates the migration mapper output end-to-end.
 *
 * Pure registry / compile logic; no Mongo, no Redis.
 */
import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

import {
  getRegistryEntry,
  hasSubtype,
  listSubtypes,
  getEntriesByType,
  getEntriesByCategory,
  validateNodeConfig,
} from "../../src/services/workflow/actionRegistry.js";
import { compileWorkflow } from "../../src/services/workflow/compileWorkflow.js";
import { validateConfig } from "../../src/services/workflow/configValidator.js";
import { mapAutomationRuleToWorkflowDefinition } from "../../src/services/workflowMigrationService.js";

describe("actionRegistry — shape and contents", () => {
  it("seeds every entry with the contract fields", () => {
    const subtypes = listSubtypes();
    expect(subtypes.length).toBeGreaterThan(0);
    for (const subtype of subtypes) {
      const entry = getRegistryEntry(subtype);
      expect(entry).toBeDefined();
      expect(entry.subtype).toBe(subtype);
      expect(entry.type).toMatch(
        /^(trigger|condition|action|ai|approval|delay|branch)$/,
      );
      expect(entry.status).toMatch(/^(stable|preview|deprecated)$/);
      expect(typeof entry.requiresApproval).toBe("boolean");
      expect(typeof entry.idempotent).toBe("boolean");
      expect(typeof entry.executor).toBe("string");
      expect(entry.configSchema).toBeDefined();
    }
  });

  it("has unique subtype IDs", () => {
    const subtypes = listSubtypes();
    expect(new Set(subtypes).size).toBe(subtypes.length);
  });

  it("seeds the v1 module × trigger event cross-product", () => {
    const modules = ["lead", "contact", "account", "deal", "activity"];
    const events = [
      "on_create",
      "on_update",
      "on_stage_change",
      "on_field_change",
      "time_based",
    ];
    for (const m of modules) {
      for (const e of events) {
        const subtype = `trigger.${m}.${e}`;
        expect(hasSubtype(subtype)).toBe(true);
        expect(getRegistryEntry(subtype).type).toBe("trigger");
      }
    }
  });

  it("seeds the v1 action subtypes emitted by the migration mapper", () => {
    for (const subtype of [
      "action.crm.create_task",
      "action.crm.update_field",
      "action.crm.assign_owner",
      "action.notification.send",
      "action.webhook.call",
    ]) {
      expect(hasSubtype(subtype)).toBe(true);
      expect(getRegistryEntry(subtype).type).toBe("action");
    }
  });

  it("seeds the engine primitives", () => {
    expect(getRegistryEntry("condition.expression").type).toBe("condition");
    expect(getRegistryEntry("approval.request").type).toBe("approval");
    expect(getRegistryEntry("delay.wait").type).toBe("delay");
    expect(getRegistryEntry("branch.switch").type).toBe("branch");
  });

  it("flags outbound provider actions as preview + requiresApproval", () => {
    for (const subtype of [
      "action.gmail.send",
      "action.whatsapp.send",
      "action.meta.publish",
      "action.gmb.reply",
    ]) {
      const entry = getRegistryEntry(subtype);
      expect(entry.status).toBe("preview");
      expect(entry.requiresApproval).toBe(true);
    }
  });

  it("seeds AI placeholder subtypes with planFeature gates", () => {
    const ai = getRegistryEntry("ai.draft.email");
    expect(ai.type).toBe("ai");
    expect(ai.status).toBe("preview");
    expect(ai.planFeature).toBe("aiDrafts");
    expect(ai.requiresApproval).toBe(true);
    expect(getRegistryEntry("ai.classify.lead_quality").planFeature).toBe(
      "aiLeadScoring",
    );
  });

  it("getEntriesByType / getEntriesByCategory filter correctly", () => {
    const triggers = getEntriesByType("trigger");
    expect(triggers.every((e) => e.type === "trigger")).toBe(true);
    expect(triggers.length).toBeGreaterThan(0);

    const aiEntries = getEntriesByCategory("ai");
    expect(aiEntries.every((e) => e.category === "ai")).toBe(true);
    expect(aiEntries.length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown subtype", () => {
    expect(getRegistryEntry("action.does.not.exist")).toBeUndefined();
    expect(hasSubtype("nope")).toBe(false);
  });
});

describe("validateConfig / validateNodeConfig", () => {
  it("rejects missing required fields", () => {
    const result = validateNodeConfig("action.crm.create_task", {});
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("title"))).toBe(true);
  });

  it("accepts valid action.crm.create_task config", () => {
    const result = validateNodeConfig("action.crm.create_task", {
      title: "Follow up",
      dueInDays: 3,
      priority: "high",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects bad enum values", () => {
    const result = validateNodeConfig("action.crm.create_task", {
      title: "X",
      priority: "bogus",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("priority"))).toBe(true);
  });

  it("rejects bad ObjectId strings", () => {
    const result = validateNodeConfig("action.crm.assign_owner", {
      ownerId: "not-an-objectid",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ownerId"))).toBe(true);
  });

  it("validates nested array of objects (condition.expression)", () => {
    const ok = validateNodeConfig("condition.expression", {
      combinator: "AND",
      conditions: [
        { field: "status", operator: "equals" },
        { field: "amount", operator: "greater_than" },
      ],
    });
    expect(ok.ok).toBe(true);

    const bad = validateNodeConfig("condition.expression", {
      combinator: "XOR",
      conditions: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.includes("combinator"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("at least 1 items"))).toBe(true);
  });

  it("returns no errors when schema has no fields", () => {
    expect(validateConfig({ fields: {} }, {})).toEqual([]);
    expect(validateConfig({}, { anything: 1 })).toEqual([]);
  });

  it("rejects non-object config", () => {
    expect(validateConfig({ fields: { x: { type: "string" } } }, "string"))
      .toContainEqual(expect.stringContaining("must be an object"));
  });
});

describe("compileWorkflow", () => {
  function leadCreatedNotifyGraph(overrides = {}) {
    return {
      nodes: overrides.nodes || [
        {
          id: "t0",
          type: "trigger",
          subtype: "trigger.lead.on_create",
          config: {},
        },
        {
          id: "a0",
          type: "action",
          subtype: "action.notification.send",
          config: { title: "New lead", body: "Check the CRM." },
        },
      ],
      edges: overrides.edges || [{ id: "e0", from: "t0", to: "a0" }],
    };
  }

  it("accepts a valid trigger → action graph", () => {
    const result = compileWorkflow(leadCreatedNotifyGraph());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.triggerSubtypes).toEqual(["trigger.lead.on_create"]);
    expect(result.summary.planFeatures).toContain("workflowBuilder");
  });

  it("rejects unknown subtypes", () => {
    const result = compileWorkflow({
      nodes: [
        { id: "t0", type: "trigger", subtype: "trigger.unknown.event", config: {} },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unknown subtype/.test(e.message))).toBe(true);
  });

  it("rejects type/subtype mismatch", () => {
    const result = compileWorkflow({
      nodes: [
        // condition.expression registered as type:"condition"
        {
          id: "t0",
          type: "trigger",
          subtype: "condition.expression",
          config: { combinator: "AND", conditions: [{ field: "x", operator: "equals" }] },
        },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /expects type/.test(e.message))).toBe(true);
  });

  it("rejects edges to unknown nodes", () => {
    const result = compileWorkflow(
      leadCreatedNotifyGraph({
        edges: [{ id: "e0", from: "t0", to: "ghost" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.scope === "edge" && /unknown node "ghost"/.test(e.message),
      ),
    ).toBe(true);
  });

  it("rejects self-loop edges", () => {
    const result = compileWorkflow(
      leadCreatedNotifyGraph({
        edges: [{ id: "e0", from: "t0", to: "t0" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /self-loop/.test(e.message))).toBe(true);
  });

  it("requires at least one trigger node", () => {
    const result = compileWorkflow({
      nodes: [
        {
          id: "a0",
          type: "action",
          subtype: "action.notification.send",
          config: { title: "x" },
        },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /no trigger nodes/.test(e.message))).toBe(
      true,
    );
  });

  it("rejects duplicate node ids", () => {
    const result = compileWorkflow({
      nodes: [
        { id: "n1", type: "trigger", subtype: "trigger.lead.on_create", config: {} },
        {
          id: "n1",
          type: "action",
          subtype: "action.notification.send",
          config: { title: "x" },
        },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /duplicate node id/.test(e.message))).toBe(
      true,
    );
  });

  it("emits a preview warning for AI placeholder subtypes", () => {
    const result = compileWorkflow({
      nodes: [
        {
          id: "t0",
          type: "trigger",
          subtype: "trigger.lead.on_create",
          config: {},
        },
        {
          id: "ai0",
          type: "ai",
          subtype: "ai.classify.lead_quality",
          config: {},
        },
      ],
      edges: [{ id: "e0", from: "t0", to: "ai0" }],
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => /preview-only/.test(w.message)),
    ).toBe(true);
  });

  it("propagates requiresApproval into the summary", () => {
    const result = compileWorkflow({
      nodes: [
        {
          id: "t0",
          type: "trigger",
          subtype: "trigger.lead.on_create",
          config: {},
        },
        {
          id: "ap0",
          type: "approval",
          subtype: "approval.request",
          config: { approverRole: "admin", message: "Approve?" },
        },
      ],
      edges: [{ id: "e0", from: "t0", to: "ap0" }],
    });
    expect(result.ok).toBe(true);
    expect(result.summary.requiresApproval).toBe(true);
    expect(result.summary.planFeatures).toContain("approvalQueue");
  });

  it("returns a workflow-level error for missing input", () => {
    expect(compileWorkflow(null).ok).toBe(false);
    expect(compileWorkflow(undefined).ok).toBe(false);
    expect(compileWorkflow({ nodes: [], edges: [] }).ok).toBe(false);
  });
});

describe("compileWorkflow ↔ workflowMigrationService", () => {
  it("compiles a graph produced from every v1 action subtype", () => {
    const tenantId = "abcdef0123456789abcdef01"; // 24-char hex string
    const v1Rule = {
      _id: "feedfacef00dfeedfacef00d",
      tenantId,
      module: "lead",
      name: "Migrate me",
      isActive: true,
      trigger: { type: "on_create", config: {} },
      conditions: [
        { field: "status", operator: "equals", value: "new" },
      ],
      actions: [
        {
          type: "create_task",
          config: { title: "Follow up", dueInDays: 1 },
        },
        {
          type: "update_field",
          config: { field: "status", value: "contacted" },
        },
        { type: "assign_owner", config: { ownerStrategy: "round_robin" } },
        {
          type: "send_notification",
          config: { title: "New lead", recipientRole: "owner" },
        },
        {
          type: "webhook",
          config: {
            url: "https://example.com/hook",
            method: "POST",
            timeoutMs: 5000,
          },
        },
      ],
      createdBy: "0011223344556677889900aa",
    };

    const def = mapAutomationRuleToWorkflowDefinition(v1Rule);
    const result = compileWorkflow(def);

    if (!result.ok) {
      // Surface failures in the test output for fast diagnosis.
      console.error("compile errors:", result.errors);
    }
    expect(result.ok).toBe(true);
    expect(result.summary.triggerSubtypes).toEqual([
      "trigger.lead.on_create",
    ]);
  });

  it("flags an unmapped v1 action as unknown subtype at compile time", () => {
    const tenantId = "abcdef0123456789abcdef01";
    const v1Rule = {
      _id: "feedfacef00dfeedfacef00d",
      tenantId,
      module: "lead",
      name: "Bad rule",
      trigger: { type: "on_create", config: {} },
      conditions: [],
      actions: [
        {
          type: "future_action_we_havent_mapped",
          config: { foo: 1 },
        },
      ],
      createdBy: "0011223344556677889900aa",
    };
    const def = mapAutomationRuleToWorkflowDefinition(v1Rule);
    expect(def.nodes.some((n) => n.subtype.startsWith("action.unknown."))).toBe(
      true,
    );
    const result = compileWorkflow(def);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => /unknown subtype/.test(e.message)),
    ).toBe(true);
  });
});
