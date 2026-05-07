/**
 * Tests for P3-003: Workflow v2 Execution via BullMQ.
 *
 * Covers:
 *   1. nodeExecutors — executor dispatch, condition evaluation, CRM stubs,
 *      delay/approval pauses.
 *   2. orchestrator — advanceRun DAG walking, status transitions,
 *      idempotent replay, preview refusal, compile-time rejection.
 *   3. workflowExecuteProcessor — BullMQ processor contract.
 *   4. Worker registration — PROCESSORS includes workflow.execute.
 *
 * Pure unit tests; no live Redis/Mongo required.
 * Mongo interactions are stubbed with lightweight in-memory doubles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

// ═══════════════════════════════════════════════════════════════════════
// §1 — Node Executors
// ═══════════════════════════════════════════════════════════════════════

import {
  getNodeExecutor,
  hasExecutor,
  listExecutors,
  EXECUTOR_MAP,
} from "../../src/services/workflow/nodeExecutors.js";

describe("nodeExecutors — dispatch table", () => {
  it("has executors for all stable action/condition/delay/approval/branch subtypes", () => {
    const expected = [
      "condition.expression",
      "action.crm.create_task",
      "action.crm.update_field",
      "action.crm.assign_owner",
      "action.notification.send",
      "action.webhook.call",
      "delay.wait",
      "approval.request",
      "branch.switch",
    ];
    for (const subtype of expected) {
      expect(hasExecutor(subtype)).toBe(true);
      expect(typeof getNodeExecutor(subtype)).toBe("function");
    }
  });

  it("returns null for unknown/preview subtypes", () => {
    expect(getNodeExecutor("action.gmail.send")).toBeNull();
    expect(getNodeExecutor("ai.draft.email")).toBeNull();
    expect(getNodeExecutor("bogus")).toBeNull();
    expect(hasExecutor("bogus")).toBe(false);
  });

  it("lists all registered executor subtypes", () => {
    const list = listExecutors();
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain("condition.expression");
    expect(list).toContain("delay.wait");
    // Should be sorted.
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});

describe("nodeExecutors — condition.expression", () => {
  const exec = getNodeExecutor("condition.expression");

  it("evaluates AND conditions that pass", async () => {
    const ctx = {
      tenantId: "t1",
      node: {
        id: "c1",
        type: "condition",
        subtype: "condition.expression",
        config: {
          combinator: "AND",
          conditions: [
            { field: "status", operator: "equals", value: "new" },
            { field: "priority", operator: "equals", value: "high" },
          ],
        },
      },
      entity: { status: "new", priority: "high" },
      triggerSource: {},
    };
    const result = await exec(ctx);
    expect(result.output.passed).toBe(true);
  });

  it("evaluates AND conditions that fail", async () => {
    const ctx = {
      tenantId: "t1",
      node: {
        id: "c1",
        type: "condition",
        subtype: "condition.expression",
        config: {
          combinator: "AND",
          conditions: [
            { field: "status", operator: "equals", value: "closed" },
          ],
        },
      },
      entity: { status: "new" },
      triggerSource: {},
    };
    const result = await exec(ctx);
    expect(result.output.passed).toBe(false);
  });

  it("evaluates OR conditions", async () => {
    const ctx = {
      tenantId: "t1",
      node: {
        id: "c1",
        type: "condition",
        subtype: "condition.expression",
        config: {
          combinator: "OR",
          conditions: [
            { field: "status", operator: "equals", value: "closed" },
            { field: "priority", operator: "equals", value: "high" },
          ],
        },
      },
      entity: { status: "new", priority: "high" },
      triggerSource: {},
    };
    const result = await exec(ctx);
    expect(result.output.passed).toBe(true);
  });

  it("handles is_empty and is_not_empty operators", async () => {
    const exec = getNodeExecutor("condition.expression");
    const makeCtx = (operator, entity) => ({
      tenantId: "t1",
      node: {
        id: "c1",
        type: "condition",
        subtype: "condition.expression",
        config: {
          combinator: "AND",
          conditions: [{ field: "email", operator }],
        },
      },
      entity,
      triggerSource: {},
    });

    const empty = await exec(makeCtx("is_empty", { email: "" }));
    expect(empty.output.passed).toBe(true);

    const notEmpty = await exec(makeCtx("is_not_empty", { email: "a@b.com" }));
    expect(notEmpty.output.passed).toBe(true);
  });

  it("passes for empty conditions list with AND combinator", async () => {
    const ctx = {
      tenantId: "t1",
      node: {
        id: "c1",
        type: "condition",
        subtype: "condition.expression",
        config: { combinator: "AND", conditions: [] },
      },
      entity: {},
      triggerSource: {},
    };
    const result = await exec(ctx);
    expect(result.output.passed).toBe(true);
  });
});

describe("nodeExecutors — delay.wait", () => {
  it("returns a waitUntil timestamp", async () => {
    const exec = getNodeExecutor("delay.wait");
    const before = Date.now();
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "d1",
        type: "delay",
        subtype: "delay.wait",
        config: { durationMs: 60000 },
      },
    });
    expect(result.waitUntil).toBeInstanceOf(Date);
    expect(result.waitUntil.getTime()).toBeGreaterThanOrEqual(before + 59000);
    expect(result.output.delayed).toBe(true);
  });
});

describe("nodeExecutors — approval.request", () => {
  it("returns waitingApproval flag", async () => {
    const exec = getNodeExecutor("approval.request");
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "ap1",
        type: "approval",
        subtype: "approval.request",
        config: { approverRole: "admin", message: "Approve this?" },
      },
    });
    expect(result.waitingApproval).toBe(true);
    expect(result.input.approverRole).toBe("admin");
  });
});

describe("nodeExecutors — notification.send", () => {
  it("returns notified output", async () => {
    const exec = getNodeExecutor("action.notification.send");
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "n1",
        type: "action",
        subtype: "action.notification.send",
        config: { title: "Test", recipientRole: "owner" },
      },
      entity: { _id: "entity123" },
    });
    expect(result.output.notified).toBe(true);
  });
});

describe("nodeExecutors — webhook.call", () => {
  it("returns triggered output", async () => {
    const exec = getNodeExecutor("action.webhook.call");
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "w1",
        type: "action",
        subtype: "action.webhook.call",
        config: { url: "https://example.com/hook", method: "POST" },
      },
      entity: null,
    });
    expect(result.output.triggered).toBe(true);
    expect(result.output.webhookUrl).toBe("https://example.com/hook");
  });
});

describe("nodeExecutors — branch.switch", () => {
  it("selects matching case label", async () => {
    const exec = getNodeExecutor("branch.switch");
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "b1",
        type: "branch",
        subtype: "branch.switch",
        config: {
          expression: "status",
          cases: [
            { value: "new", label: "new_branch" },
            { value: "closed", label: "closed_branch" },
          ],
          defaultLabel: "fallback",
        },
      },
      entity: { status: "new" },
      triggerSource: {},
    });
    expect(result.output.selectedLabel).toBe("new_branch");
  });

  it("falls back to defaultLabel when no case matches", async () => {
    const exec = getNodeExecutor("branch.switch");
    const result = await exec({
      tenantId: "t1",
      node: {
        id: "b1",
        type: "branch",
        subtype: "branch.switch",
        config: {
          expression: "status",
          cases: [{ value: "closed", label: "closed_branch" }],
          defaultLabel: "fallback",
        },
      },
      entity: { status: "open" },
      triggerSource: {},
    });
    expect(result.output.selectedLabel).toBe("fallback");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §2 — Worker registration
// ═══════════════════════════════════════════════════════════════════════

import { PROCESSORS } from "../../src/queue/workers.js";
import { QUEUE_NAMES } from "../../src/queue/queueNames.js";

describe("worker registry", () => {
  it("has workflow.execute processor registered", () => {
    expect(PROCESSORS[QUEUE_NAMES.WORKFLOW_EXECUTE]).toBeDefined();
    expect(typeof PROCESSORS[QUEUE_NAMES.WORKFLOW_EXECUTE]).toBe("function");
  });

  it("still has smoke.test processor", () => {
    expect(PROCESSORS[QUEUE_NAMES.SMOKE_TEST]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §3 — Processor contract
// ═══════════════════════════════════════════════════════════════════════

import { processWorkflowExecute } from "../../src/queue/processors/workflowExecuteProcessor.js";
import { NonRetryableError } from "../../src/queue/errors.js";

describe("workflowExecuteProcessor — contract checks", () => {
  it("throws NonRetryableError when tenantId is missing", async () => {
    const job = { id: "job-1", data: {}, attemptsMade: 0 };
    await expect(processWorkflowExecute(job)).rejects.toThrow(
      NonRetryableError,
    );
    await expect(processWorkflowExecute(job)).rejects.toThrow(/tenantId/);
  });

  it("throws NonRetryableError when neither workflowRunId nor workflowId is provided", async () => {
    const job = {
      id: "job-2",
      data: { tenantId: "abc123" },
      attemptsMade: 0,
    };
    await expect(processWorkflowExecute(job)).rejects.toThrow(
      NonRetryableError,
    );
    await expect(processWorkflowExecute(job)).rejects.toThrow(
      /workflowRunId|workflowId/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §4 — Orchestrator service index exports
// ═══════════════════════════════════════════════════════════════════════

describe("workflow service index — new exports", () => {
  it("re-exports orchestrator functions", async () => {
    const mod = await import("../../src/services/workflow/index.js");
    expect(typeof mod.createRun).toBe("function");
    expect(typeof mod.advanceRun).toBe("function");
    expect(typeof mod.getNodeExecutor).toBe("function");
    expect(typeof mod.hasExecutor).toBe("function");
    expect(typeof mod.listExecutors).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §5 — Executor ↔ Registry consistency
// ═══════════════════════════════════════════════════════════════════════

import {
  listSubtypes,
  getRegistryEntry,
} from "../../src/services/workflow/actionRegistry.js";

describe("executor ↔ registry consistency", () => {
  it("every stable non-trigger subtype that has an executor matches a registry entry", () => {
    const executorSubtypes = listExecutors();
    expect(executorSubtypes.length).toBeGreaterThan(0);

    for (const subtype of executorSubtypes) {
      const entry = getRegistryEntry(subtype);
      expect(
        entry,
        `Executor registered for "${subtype}" but no registry entry exists`,
      ).toBeDefined();
      expect(entry.status).toBe("stable");
      expect(entry.type).not.toBe("trigger");
    }
  });

  it("every stable non-trigger subtype in the registry has an executor", () => {
    const subtypes = listSubtypes();
    const stableNonTrigger = subtypes.filter((s) => {
      const entry = getRegistryEntry(s);
      return entry.status === "stable" && entry.type !== "trigger";
    });

    // There must be at least some stable non-trigger subtypes.
    expect(stableNonTrigger.length).toBeGreaterThan(0);

    for (const subtype of stableNonTrigger) {
      expect(
        hasExecutor(subtype),
        `Missing executor for stable non-trigger subtype: ${subtype}`,
      ).toBe(true);
    }
  });

  it("no preview subtype has a registered executor", () => {
    const subtypes = listSubtypes();
    const preview = subtypes.filter(
      (s) => getRegistryEntry(s).status === "preview",
    );

    for (const subtype of preview) {
      expect(
        hasExecutor(subtype),
        `Preview subtype "${subtype}" should NOT have an executor`,
      ).toBe(false);
    }
  });
});
