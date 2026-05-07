/**
 * Tests for the P3-001 Workflow v2 model layer:
 *   1. Workflow schema — validation (trigger required, unique node ids,
 *      unique edge ids), denormalized triggerSubtypes, lineageId default,
 *      tenant isolation, soft delete fields, versioning lineage.
 *   2. WorkflowRun schema — node-run sub-document defaults, runKey unique
 *      partial index (allows multiple null runKeys, blocks duplicate
 *      strings per workflow), tenant isolation, version pinning,
 *      idempotencyKey persistence on outbound nodes.
 *   3. workflowMigrationService.mapAutomationRuleToWorkflowDefinition —
 *      pure mapper output shape, condition folding, action subtype
 *      routing, validation guards.
 *
 * These tests run against an in-memory Mongo instance and do NOT spin
 * up Redis or the BullMQ workers — model layer only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let Workflow;
let WorkflowRun;
let AutomationRule;
let mapAutomationRuleToWorkflowDefinition;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Workflow = (await import("../../src/models/Workflow.js")).default;
  WorkflowRun = (await import("../../src/models/WorkflowRun.js")).default;
  AutomationRule = (await import("../../src/models/crm/AutomationRule.js"))
    .default;
  ({ mapAutomationRuleToWorkflowDefinition } = await import(
    "../../src/services/workflowMigrationService.js"
  ));

  // Build indexes for the partial unique runKey index, etc.
  await Workflow.syncIndexes();
  await WorkflowRun.syncIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

function buildLeadCreatedDefinition(overrides = {}) {
  const tenantId = overrides.tenantId || new mongoose.Types.ObjectId();
  const createdBy = overrides.createdBy || new mongoose.Types.ObjectId();
  return {
    tenantId,
    name: overrides.name || "Lead created → notify owner",
    createdBy,
    nodes: overrides.nodes || [
      {
        id: "trigger_0",
        type: "trigger",
        subtype: "trigger.lead.on_create",
        label: "Lead created",
      },
      {
        id: "action_0",
        type: "action",
        subtype: "action.notification.send",
        label: "Notify owner",
        config: { to: "owner", message: "New lead." },
      },
    ],
    edges: overrides.edges || [{ id: "e_0", from: "trigger_0", to: "action_0" }],
    ...overrides,
  };
}

describe("Workflow model — schema and validation", () => {
  it("requires at least one trigger node", async () => {
    const def = buildLeadCreatedDefinition({
      nodes: [
        {
          id: "action_0",
          type: "action",
          subtype: "action.notification.send",
          config: {},
        },
      ],
      edges: [],
    });
    await expect(Workflow.create(def)).rejects.toThrow(/trigger node/i);
  });

  it("rejects duplicate node ids", async () => {
    const def = buildLeadCreatedDefinition({
      nodes: [
        { id: "n1", type: "trigger", subtype: "trigger.lead.on_create" },
        { id: "n1", type: "action", subtype: "action.notification.send" },
      ],
      edges: [{ id: "e_0", from: "n1", to: "n1" }],
    });
    await expect(Workflow.create(def)).rejects.toThrow(/unique node IDs/i);
  });

  it("rejects duplicate edge ids", async () => {
    const def = buildLeadCreatedDefinition({
      edges: [
        { id: "e_dup", from: "trigger_0", to: "action_0" },
        { id: "e_dup", from: "trigger_0", to: "action_0" },
      ],
    });
    await expect(Workflow.create(def)).rejects.toThrow(/Edge IDs must be unique/i);
  });

  it("denormalizes triggerSubtypes from trigger nodes", async () => {
    const wf = await Workflow.create(
      buildLeadCreatedDefinition({
        nodes: [
          { id: "t1", type: "trigger", subtype: "trigger.lead.on_create" },
          { id: "t2", type: "trigger", subtype: "trigger.deal.on_stage_change" },
          {
            id: "t1_dup_subtype",
            type: "trigger",
            subtype: "trigger.lead.on_create",
          },
          {
            id: "a1",
            type: "action",
            subtype: "action.notification.send",
          },
        ],
        edges: [
          { id: "e1", from: "t1", to: "a1" },
          { id: "e2", from: "t2", to: "a1" },
        ],
      }),
    );

    expect(wf.triggerSubtypes.sort()).toEqual([
      "trigger.deal.on_stage_change",
      "trigger.lead.on_create",
    ]);
  });

  it("defaults lineageId to its own _id on first version", async () => {
    const wf = await Workflow.create(buildLeadCreatedDefinition());
    expect(wf.lineageId.toString()).toBe(wf._id.toString());
    expect(wf.version).toBe(1);
    expect(wf.status).toBe("draft");
  });

  it("preserves an explicit lineageId across versions", async () => {
    const v1 = await Workflow.create(buildLeadCreatedDefinition());
    const v2 = await Workflow.create({
      ...buildLeadCreatedDefinition({
        tenantId: v1.tenantId,
        createdBy: v1.createdBy,
      }),
      lineageId: v1.lineageId,
      previousVersionId: v1._id,
      version: 2,
    });

    expect(v2.lineageId.toString()).toBe(v1.lineageId.toString());
    expect(v2.version).toBe(2);
    expect(v2.previousVersionId.toString()).toBe(v1._id.toString());
  });

  it("isolates workflows by tenantId", async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const tenantB = new mongoose.Types.ObjectId();
    await Workflow.create(buildLeadCreatedDefinition({ tenantId: tenantA }));
    await Workflow.create(buildLeadCreatedDefinition({ tenantId: tenantB }));

    const a = await Workflow.find({ tenantId: tenantA });
    const b = await Workflow.find({ tenantId: tenantB });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("supports the migratedFromAutomationRuleId lineage field", async () => {
    const ruleId = new mongoose.Types.ObjectId();
    const wf = await Workflow.create(
      buildLeadCreatedDefinition({ migratedFromAutomationRuleId: ruleId }),
    );
    expect(wf.migratedFromAutomationRuleId.toString()).toBe(ruleId.toString());
  });
});

describe("WorkflowRun model — schema and indexes", () => {
  async function seedWorkflow(overrides = {}) {
    return Workflow.create(buildLeadCreatedDefinition(overrides));
  }

  it("creates a run with pinned workflowVersion and node-run defaults", async () => {
    const wf = await seedWorkflow();
    const run = await WorkflowRun.create({
      tenantId: wf.tenantId,
      workflowId: wf._id,
      workflowLineageId: wf.lineageId,
      workflowVersion: wf.version,
      triggerSource: {
        type: "on_create",
        subtype: "trigger.lead.on_create",
        entityType: "lead",
        entityId: new mongoose.Types.ObjectId(),
      },
      nodeRuns: [
        {
          nodeId: "trigger_0",
          nodeType: "trigger",
          nodeSubtype: "trigger.lead.on_create",
        },
        {
          nodeId: "action_0",
          nodeType: "action",
          nodeSubtype: "action.notification.send",
          maxAttempts: 5,
          idempotencyKey: "wf-1:action_0:lead-abc",
        },
      ],
    });

    expect(run.status).toBe("pending");
    expect(run.workflowVersion).toBe(1);
    expect(run.nodeRuns[0].status).toBe("pending");
    expect(run.nodeRuns[0].attemptsMade).toBe(0);
    expect(run.nodeRuns[1].idempotencyKey).toBe("wf-1:action_0:lead-abc");
    expect(run.nodeRuns[1].error.nonRetryable).toBe(false);
  });

  it("enforces unique runKey per (tenant, workflow)", async () => {
    const wf = await seedWorkflow();
    const base = {
      tenantId: wf.tenantId,
      workflowId: wf._id,
      workflowLineageId: wf.lineageId,
      workflowVersion: wf.version,
      triggerSource: {
        type: "on_create",
        entityType: "lead",
        entityId: new mongoose.Types.ObjectId(),
      },
      runKey: `${wf._id}:lead:abc`,
    };

    await WorkflowRun.create(base);
    await expect(WorkflowRun.create(base)).rejects.toThrow();
  });

  it("allows multiple runs with no runKey (partial index)", async () => {
    const wf = await seedWorkflow();
    const base = {
      tenantId: wf.tenantId,
      workflowId: wf._id,
      workflowLineageId: wf.lineageId,
      workflowVersion: wf.version,
      triggerSource: {
        type: "manual",
        entityType: "manual",
      },
    };

    const r1 = await WorkflowRun.create(base);
    const r2 = await WorkflowRun.create(base);
    expect(r1._id.toString()).not.toBe(r2._id.toString());
  });

  it("scopes runs strictly by tenantId", async () => {
    const wfA = await seedWorkflow();
    const wfB = await seedWorkflow();

    await WorkflowRun.create({
      tenantId: wfA.tenantId,
      workflowId: wfA._id,
      workflowLineageId: wfA.lineageId,
      workflowVersion: wfA.version,
      triggerSource: { type: "manual", entityType: "manual" },
    });
    await WorkflowRun.create({
      tenantId: wfB.tenantId,
      workflowId: wfB._id,
      workflowLineageId: wfB.lineageId,
      workflowVersion: wfB.version,
      triggerSource: { type: "manual", entityType: "manual" },
    });

    const a = await WorkflowRun.find({ tenantId: wfA.tenantId });
    const b = await WorkflowRun.find({ tenantId: wfB.tenantId });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].workflowId.toString()).toBe(wfA._id.toString());
  });

  it("rejects unknown nodeRun status enum values", async () => {
    const wf = await seedWorkflow();
    await expect(
      WorkflowRun.create({
        tenantId: wf.tenantId,
        workflowId: wf._id,
        workflowVersion: wf.version,
        triggerSource: { type: "manual", entityType: "manual" },
        nodeRuns: [
          {
            nodeId: "x",
            nodeType: "action",
            nodeSubtype: "action.notification.send",
            status: "exploded",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe("workflowMigrationService — AutomationRule → Workflow v2 mapper", () => {
  function buildRule(overrides = {}) {
    return {
      _id: overrides._id || new mongoose.Types.ObjectId(),
      tenantId: overrides.tenantId || new mongoose.Types.ObjectId(),
      name: overrides.name || "On lead create — notify owner",
      description: overrides.description || "",
      isActive: overrides.isActive ?? true,
      module: overrides.module || "lead",
      trigger: overrides.trigger || { type: "on_create", config: {} },
      conditions: overrides.conditions || [],
      actions: overrides.actions || [
        {
          type: "send_notification",
          config: { to: "owner", message: "Hi" },
        },
      ],
      createdBy: overrides.createdBy || new mongoose.Types.ObjectId(),
    };
  }

  it("produces a creatable Workflow v2 definition for a basic rule", async () => {
    const rule = buildRule();
    const def = mapAutomationRuleToWorkflowDefinition(rule);

    expect(def.tenantId).toBe(rule.tenantId);
    expect(def.status).toBe("draft");
    expect(def.migratedFromAutomationRuleId).toBe(rule._id);

    // trigger + 1 action, no condition node when conditions are empty
    expect(def.nodes).toHaveLength(2);
    expect(def.nodes[0].type).toBe("trigger");
    expect(def.nodes[0].subtype).toBe("trigger.lead.on_create");
    expect(def.nodes[1].type).toBe("action");
    expect(def.nodes[1].subtype).toBe("action.notification.send");
    expect(def.edges).toEqual([
      { id: "e_0", from: "trigger_0", to: "action_0" },
    ]);

    // Round-trip through the model — proves the mapper output is valid.
    const wf = await Workflow.create(def);
    expect(wf.triggerSubtypes).toEqual(["trigger.lead.on_create"]);
  });

  it("folds v1 conditions into a single condition.expression node", async () => {
    const rule = buildRule({
      conditions: [
        { field: "source", operator: "equals", value: "ads" },
        { field: "status", operator: "not_equals", value: "lost" },
      ],
    });
    const def = mapAutomationRuleToWorkflowDefinition(rule);

    expect(def.nodes).toHaveLength(3);
    expect(def.nodes[1].type).toBe("condition");
    expect(def.nodes[1].subtype).toBe("condition.expression");
    expect(def.nodes[1].config.combinator).toBe("AND");
    expect(def.nodes[1].config.conditions).toHaveLength(2);
    expect(def.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "trigger_0->condition_0",
      "condition_0->action_0",
    ]);
  });

  it("maps every legacy v1 action type to a v2 subtype", () => {
    const rule = buildRule({
      actions: [
        { type: "create_task", config: { subject: "Follow up" } },
        { type: "update_field", config: { field: "status", value: "qualified" } },
        { type: "assign_owner", config: { ownerId: "abc" } },
        { type: "send_notification", config: { to: "owner" } },
        { type: "webhook", config: { url: "https://ex.com/hook" } },
      ],
    });
    const def = mapAutomationRuleToWorkflowDefinition(rule);
    const actionSubtypes = def.nodes
      .filter((n) => n.type === "action")
      .map((n) => n.subtype);
    expect(actionSubtypes).toEqual([
      "action.crm.create_task",
      "action.crm.update_field",
      "action.crm.assign_owner",
      "action.notification.send",
      "action.webhook.call",
    ]);
  });

  it("falls back to action.unknown.* for unrecognised v1 action types", () => {
    const rule = buildRule({
      actions: [{ type: "fancy_new_thing", config: {} }],
    });
    const def = mapAutomationRuleToWorkflowDefinition(rule);
    expect(def.nodes[1].subtype).toBe("action.unknown.fancy_new_thing");
  });

  it("validates required fields", () => {
    expect(() => mapAutomationRuleToWorkflowDefinition(null)).toThrow(
      /rule is required/,
    );
    expect(() =>
      mapAutomationRuleToWorkflowDefinition({ tenantId: null }),
    ).toThrow(/rule.tenantId/);
    expect(() =>
      mapAutomationRuleToWorkflowDefinition({
        tenantId: new mongoose.Types.ObjectId(),
        module: "lead",
        actions: [{ type: "send_notification", config: {} }],
      }),
    ).toThrow(/rule.trigger.type/);
    expect(() =>
      mapAutomationRuleToWorkflowDefinition({
        tenantId: new mongoose.Types.ObjectId(),
        module: "lead",
        trigger: { type: "on_create", config: {} },
        actions: [],
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      mapAutomationRuleToWorkflowDefinition({
        tenantId: new mongoose.Types.ObjectId(),
        module: "lead",
        trigger: { type: "no_such_trigger" },
        actions: [{ type: "send_notification" }],
      }),
    ).toThrow(/unknown trigger type/);
  });

  it("produces deterministic output for the same input", () => {
    const sharedTenant = new mongoose.Types.ObjectId();
    const sharedCreator = new mongoose.Types.ObjectId();
    const sharedRuleId = new mongoose.Types.ObjectId();
    const baseRule = {
      _id: sharedRuleId,
      tenantId: sharedTenant,
      name: "Repeat",
      module: "deal",
      trigger: { type: "on_stage_change", config: {} },
      conditions: [{ field: "stage", operator: "equals", value: "won" }],
      actions: [{ type: "create_task", config: {} }],
      createdBy: sharedCreator,
      isActive: true,
    };
    const a = mapAutomationRuleToWorkflowDefinition(baseRule);
    const b = mapAutomationRuleToWorkflowDefinition(baseRule);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("compatibility check: legacy AutomationRule documents map cleanly", async () => {
    // Build a real AutomationRule doc to prove the mapper accepts it
    const rule = await AutomationRule.create({
      tenantId: new mongoose.Types.ObjectId(),
      name: "Real rule",
      module: "deal",
      trigger: { type: "on_stage_change", config: { from: "open", to: "won" } },
      conditions: [{ field: "amount", operator: "greater_than", value: 1000 }],
      actions: [
        { type: "create_task", config: { subject: "Send invoice" } },
        { type: "send_notification", config: { to: "owner" } },
      ],
      createdBy: new mongoose.Types.ObjectId(),
    });
    const def = mapAutomationRuleToWorkflowDefinition(rule.toObject());
    const wf = await Workflow.create(def);
    expect(wf.triggerSubtypes).toEqual(["trigger.deal.on_stage_change"]);
    expect(wf.migratedFromAutomationRuleId.toString()).toBe(
      rule._id.toString(),
    );
    expect(
      wf.nodes.find((n) => n.subtype === "action.crm.create_task"),
    ).toBeTruthy();
  });
});
