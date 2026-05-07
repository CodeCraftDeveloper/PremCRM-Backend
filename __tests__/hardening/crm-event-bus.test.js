/**
 * CRM Event Bus integration tests — P3-004.
 *
 * Validates the dual-fire mechanism that bridges CRM entity mutations
 * to both the v1 WorkflowEngine and the v2 Workflow trigger system.
 *
 * Test categories:
 *   1. Unit: buildTriggerSubtype mapping
 *   2. Integration: emitCrmEventSync with real Mongo (in-memory)
 *   3. Error isolation: v1/v2 failures don't block each other
 *   4. Dedup: singleton workflows produce run-key scoped runs
 *   5. Module coverage: all CRM modules fire correctly
 *
 * Uses MongoMemoryServer for real Mongoose operations.
 * Queue layer is mocked (no real Redis).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

// ── Mock the queue layer (no real Redis in tests) ───────────────────────
vi.mock("../../src/queue/index.js", () => ({
  enqueue: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  QUEUE_NAMES: { WORKFLOW_EXECUTE: "workflow.execute" },
  isBullConnectionEnabled: vi.fn().mockReturnValue(true),
}));

// ── Mock the v1 WorkflowEngine ─────────────────────────────────────────
vi.mock("../../src/core/crm/WorkflowEngine.js", () => ({
  default: {
    _process: vi.fn().mockResolvedValue(undefined),
    fire: vi.fn(),
  },
}));

// ── Mock the orchestrator (createRun) to avoid full workflow validation ──
let createRunCallCount = 0;
vi.mock("../../src/services/workflow/orchestrator.js", () => ({
  createRun: vi.fn().mockImplementation(async (params) => {
    createRunCallCount++;
    const id = new mongoose.Types.ObjectId();
    // Create a real WorkflowRun document in the in-memory DB
    const WorkflowRun = (await import("../../src/models/WorkflowRun.js")).default;
    const Workflow = (await import("../../src/models/Workflow.js")).default;

    const workflow = await Workflow.findById(params.workflowId).lean();

    const run = await WorkflowRun.create({
      _id: id,
      tenantId: params.tenantId,
      workflowId: params.workflowId,
      workflowVersion: workflow?.version || 1,
      status: "pending",
      triggerSource: params.triggerSource || {},
      triggeredBy: params.triggeredBy || null,
      runKey: params.runKey || null,
    });
    return run;
  }),
  advanceRun: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────────
import Workflow from "../../src/models/Workflow.js";
import WorkflowRun from "../../src/models/WorkflowRun.js";
import { enqueue } from "../../src/queue/index.js";
import WorkflowEngine from "../../src/core/crm/WorkflowEngine.js";

import {
  buildTriggerSubtype,
  emitCrmEventSync,
  __TEST_ONLY__,
} from "../../src/services/workflow/crmEventBus.js";

// ── Test fixtures ───────────────────────────────────────────────────────
let mongoServer;
const TEST_TENANT_ID = new mongoose.Types.ObjectId();
const TEST_USER_ID = new mongoose.Types.ObjectId();
const TEST_ENTITY_ID = new mongoose.Types.ObjectId();

function makeTriggerNode(module, event) {
  return {
    id: "trigger-1",
    type: "trigger",
    subtype: `trigger.${module}.${event}`,
    label: `On ${event}`,
    config: {},
    position: { x: 0, y: 0 },
    nextNodeIds: [],
  };
}

async function createTestWorkflow(overrides = {}) {
  const module = overrides.module || "deal";
  const event = overrides.event || "on_create";
  const subtype = `trigger.${module}.${event}`;

  return Workflow.create({
    tenantId: overrides.tenantId || TEST_TENANT_ID,
    name: overrides.name || `Test Workflow: ${subtype}`,
    status: overrides.status || "active",
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    version: 1,
    nodes: [makeTriggerNode(module, event)],
    edges: [],
    triggerSubtypes: [subtype],
    singleton: overrides.singleton || false,
    createdBy: TEST_USER_ID,
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: "crm_event_bus_test" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Workflow.deleteMany({});
  await WorkflowRun.deleteMany({});
  createRunCallCount = 0;
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// §1 — buildTriggerSubtype unit tests
// ═══════════════════════════════════════════════════════════════════════
describe("buildTriggerSubtype()", () => {
  it("maps valid module + triggerType to canonical subtype", () => {
    expect(buildTriggerSubtype("deal", "on_create")).toBe("trigger.deal.on_create");
    expect(buildTriggerSubtype("contact", "on_update")).toBe("trigger.contact.on_update");
    expect(buildTriggerSubtype("account", "on_stage_change")).toBe("trigger.account.on_stage_change");
    expect(buildTriggerSubtype("activity", "on_field_change")).toBe("trigger.activity.on_field_change");
    expect(buildTriggerSubtype("lead", "time_based")).toBe("trigger.lead.time_based");
  });

  it("returns null for unknown module", () => {
    expect(buildTriggerSubtype("invoice", "on_create")).toBeNull();
    expect(buildTriggerSubtype("", "on_create")).toBeNull();
  });

  it("returns null for unknown trigger type", () => {
    expect(buildTriggerSubtype("deal", "on_delete")).toBeNull();
    expect(buildTriggerSubtype("deal", "")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §2 — emitCrmEventSync integration tests
// ═══════════════════════════════════════════════════════════════════════
describe("emitCrmEventSync()", () => {
  it("fires v1 WorkflowEngine._process with correct context", async () => {
    const entity = { _id: TEST_ENTITY_ID, name: "Test Deal", amount: 5000 };

    await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity,
      user: { _id: TEST_USER_ID },
    });

    expect(WorkflowEngine._process).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TEST_TENANT_ID,
        module: "deal",
        triggerType: "on_create",
        entity,
      }),
    );
  });

  it("returns empty array when no v2 workflows match", async () => {
    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID, name: "No Match" },
    });

    expect(results).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("matches active v2 workflow and creates WorkflowRun + enqueues job", async () => {
    const wf = await createTestWorkflow({
      module: "deal",
      event: "on_create",
      tenantId: TEST_TENANT_ID,
    });

    const entity = { _id: TEST_ENTITY_ID, name: "Big Deal", amount: 10000 };

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity,
      user: { _id: TEST_USER_ID },
    });

    // Should have one result
    expect(results).toHaveLength(1);
    expect(results[0].workflowId).toBe(wf._id.toString());
    expect(results[0].runId).toBeTruthy();
    expect(results[0].jobId).toBe("mock-job-id");

    // WorkflowRun should exist in DB
    const run = await WorkflowRun.findById(results[0].runId);
    expect(run).toBeTruthy();
    expect(run.tenantId.toString()).toBe(TEST_TENANT_ID.toString());
    expect(run.workflowId.toString()).toBe(wf._id.toString());
    expect(run.triggerSource.type).toBe("on_create");
    expect(run.triggerSource.entityType).toBe("deal");

    // Enqueue should have been called
    expect(enqueue).toHaveBeenCalledWith(
      "workflow.execute",
      "v2.trigger.deal.on_create",
      expect.objectContaining({
        tenantId: TEST_TENANT_ID.toString(),
        workflowRunId: results[0].runId,
      }),
      expect.any(Object),
    );
  });

  it("matches multiple v2 workflows for the same event", async () => {
    await createTestWorkflow({ module: "contact", event: "on_create", name: "Workflow A" });
    await createTestWorkflow({ module: "contact", event: "on_create", name: "Workflow B" });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "contact",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID, name: "Jane Doe" },
    });

    expect(results).toHaveLength(2);
    expect(enqueue).toHaveBeenCalledTimes(2);

    // Both runs should exist
    const runs = await WorkflowRun.find({ tenantId: TEST_TENANT_ID });
    expect(runs).toHaveLength(2);
  });

  it("does NOT match inactive workflows", async () => {
    await createTestWorkflow({
      module: "deal",
      event: "on_create",
      isActive: false,
    });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID },
    });

    expect(results).toEqual([]);
  });

  it("does NOT match workflows with draft status", async () => {
    await createTestWorkflow({
      module: "deal",
      event: "on_create",
      status: "draft",
    });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID },
    });

    expect(results).toEqual([]);
  });

  it("does NOT match workflows from a different tenant", async () => {
    const otherTenant = new mongoose.Types.ObjectId();
    await createTestWorkflow({
      module: "deal",
      event: "on_create",
      tenantId: otherTenant,
    });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID },
    });

    expect(results).toEqual([]);
  });

  it("passes change context through triggerSource payload", async () => {
    await createTestWorkflow({ module: "deal", event: "on_stage_change" });

    const entity = { _id: TEST_ENTITY_ID, name: "Stage Deal", stage: "won" };
    const changes = { stage: { old: "negotiation", new: "won" } };

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_stage_change",
      entity,
      changes,
    });

    expect(results).toHaveLength(1);

    // The orchestrator createRun mock should have been called with changes in payload
    const { createRun } = await import("../../src/services/workflow/orchestrator.js");
    const callArgs = createRun.mock.calls[0][0];
    expect(callArgs.triggerSource.payload._changes.stage.old).toBe("negotiation");
    expect(callArgs.triggerSource.payload._changes.stage.new).toBe("won");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §3 — Error isolation tests
// ═══════════════════════════════════════════════════════════════════════
describe("Error isolation", () => {
  it("v1 engine failure does NOT prevent v2 workflows from firing", async () => {
    WorkflowEngine._process.mockRejectedValueOnce(new Error("v1 boom!"));

    await createTestWorkflow({ module: "deal", event: "on_create" });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID },
    });

    // v2 should still succeed despite v1 crash
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBeTruthy();
  });

  it("one v2 enqueue failure does NOT block other v2 workflows", async () => {
    await createTestWorkflow({ module: "account", event: "on_create", name: "WF-A" });
    await createTestWorkflow({ module: "account", event: "on_create", name: "WF-B" });

    // First enqueue call fails, second succeeds
    enqueue
      .mockRejectedValueOnce(new Error("queue boom!"))
      .mockResolvedValueOnce({ id: "job-2" });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "account",
      triggerType: "on_create",
      entity: { _id: TEST_ENTITY_ID },
    });

    // Both should have been attempted
    expect(results).toHaveLength(2);
    // At least one should have succeeded
    const successful = results.filter((r) => r.runId && !r.error);
    expect(successful.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §4 — Singleton / dedup tests
// ═══════════════════════════════════════════════════════════════════════
describe("Singleton dedup", () => {
  it("singleton workflow produces a run key based on workflowId + entityType + entityId", async () => {
    const wf = await createTestWorkflow({
      module: "deal",
      event: "on_update",
      singleton: true,
    });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_update",
      entity: { _id: TEST_ENTITY_ID },
    });

    expect(results).toHaveLength(1);

    // The createRun mock should have been called with the run key
    const { createRun } = await import("../../src/services/workflow/orchestrator.js");
    const callArgs = createRun.mock.calls[0][0];
    expect(callArgs.runKey).toBe(
      `${wf._id.toString()}:deal:${TEST_ENTITY_ID.toString()}`,
    );
  });

  it("non-singleton workflow does NOT set runKey", async () => {
    await createTestWorkflow({
      module: "deal",
      event: "on_update",
      singleton: false,
    });

    const results = await emitCrmEventSync({
      tenantId: TEST_TENANT_ID,
      module: "deal",
      triggerType: "on_update",
      entity: { _id: TEST_ENTITY_ID },
    });

    expect(results).toHaveLength(1);

    const { createRun } = await import("../../src/services/workflow/orchestrator.js");
    const callArgs = createRun.mock.calls[0][0];
    expect(callArgs.runKey).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §5 — Module coverage tests
// ═══════════════════════════════════════════════════════════════════════
describe("All CRM modules fire correctly", () => {
  const modules = ["lead", "contact", "account", "deal", "activity"];

  for (const mod of modules) {
    it(`emits on_create for module: ${mod}`, async () => {
      await createTestWorkflow({ module: mod, event: "on_create" });

      const results = await emitCrmEventSync({
        tenantId: TEST_TENANT_ID,
        module: mod,
        triggerType: "on_create",
        entity: { _id: new mongoose.Types.ObjectId(), name: `Test ${mod}` },
      });

      expect(results).toHaveLength(1);
      expect(results[0].runId).toBeTruthy();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// §6 — Internal helpers
// ═══════════════════════════════════════════════════════════════════════
describe("__TEST_ONLY__ helpers", () => {
  it("VALID_MODULES includes all CRM modules", () => {
    const { VALID_MODULES } = __TEST_ONLY__;
    expect(VALID_MODULES.has("lead")).toBe(true);
    expect(VALID_MODULES.has("contact")).toBe(true);
    expect(VALID_MODULES.has("account")).toBe(true);
    expect(VALID_MODULES.has("deal")).toBe(true);
    expect(VALID_MODULES.has("activity")).toBe(true);
  });

  it("buildRunKey produces expected format", () => {
    const { buildRunKey } = __TEST_ONLY__;
    expect(buildRunKey("wf1", "deal", "entity1")).toBe("wf1:deal:entity1");
    expect(buildRunKey("wf1", "deal", null)).toBe("wf1:deal:none");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — Service index exports
// ═══════════════════════════════════════════════════════════════════════
describe("workflow service index — CRM event bus exports", () => {
  it("re-exports emitCrmEvent, emitCrmEventSync, buildTriggerSubtype", async () => {
    const mod = await import("../../src/services/workflow/index.js");
    expect(typeof mod.emitCrmEvent).toBe("function");
    expect(typeof mod.emitCrmEventSync).toBe("function");
    expect(typeof mod.buildTriggerSubtype).toBe("function");
  });
});
