/**
 * Tests for the P2-001 BullMQ Foundation:
 *   1. Canonical queue name registry (constants, uniqueness, immutability)
 *   2. Graceful degradation when REDIS_URL is unset (matches the redis.js pattern)
 *   3. enqueue() input contract (known queue name, jobName, payload.tenantId)
 *   4. registerWorker() input contract
 *
 * These tests intentionally avoid spinning up a real Redis. End-to-end
 * lifecycle of an actual job is validated manually via the smoke-test
 * processor + worker process when Redis is available.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

describe("BullMQ foundation — queue name registry", () => {
  it("exposes the canonical queue set with unique frozen values", async () => {
    const { QUEUE_NAMES, QUEUE_NAME_LIST, isKnownQueueName } = await import(
      "../../src/queue/queueNames.js"
    );

    expect(QUEUE_NAME_LIST.length).toBeGreaterThan(0);
    expect(new Set(QUEUE_NAME_LIST).size).toBe(QUEUE_NAME_LIST.length);

    // Spot-check that critical blueprint queues exist
    expect(QUEUE_NAMES.SMOKE_TEST).toBe("smoke.test");
    expect(QUEUE_NAMES.WORKFLOW_EXECUTE).toBe("workflow.execute");
    expect(QUEUE_NAMES.AI_DRAFT).toBe("ai.draft");
    expect(QUEUE_NAMES.GMAIL_SYNC).toBe("gmail.sync");
    expect(QUEUE_NAMES.WHATSAPP_MESSAGES).toBe("whatsapp.messages");
    expect(QUEUE_NAMES.GMB_REVIEWS).toBe("gmb.reviews");
    expect(QUEUE_NAMES.META_SOCIAL_PUBLISH).toBe("meta.social.publish");
    expect(QUEUE_NAMES.ANALYTICS_ROLLUP).toBe("analytics.rollup");
    expect(QUEUE_NAMES.BILLING_METER).toBe("billing.meter");

    expect(Object.isFrozen(QUEUE_NAMES)).toBe(true);
    expect(Object.isFrozen(QUEUE_NAME_LIST)).toBe(true);

    expect(isKnownQueueName("workflow.execute")).toBe(true);
    expect(isKnownQueueName("not.a.real.queue")).toBe(false);
  });
});

describe("BullMQ foundation — graceful degradation without REDIS_URL", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "";
  });

  it("getBullConnection returns null when REDIS_URL is empty", async () => {
    const { getBullConnection, closeBullConnection, isBullConnectionEnabled } =
      await import("../../src/queue/connection.js");

    expect(isBullConnectionEnabled()).toBe(false);
    expect(getBullConnection()).toBeNull();
    await closeBullConnection(); // safe no-op
  });

  it("getQueue returns null when Redis is not configured", async () => {
    const { getQueue } = await import("../../src/queue/registry.js");
    const { QUEUE_NAMES } = await import("../../src/queue/queueNames.js");

    expect(getQueue(QUEUE_NAMES.SMOKE_TEST)).toBeNull();
    expect(getQueue(QUEUE_NAMES.WORKFLOW_EXECUTE)).toBeNull();
  });

  it("getQueue throws on an unknown queue name", async () => {
    const { getQueue } = await import("../../src/queue/registry.js");
    expect(() => getQueue("not.a.queue")).toThrow(/Unknown queue name/);
  });

  it("initQueues is a no-op when Redis is disabled", async () => {
    const { initQueues } = await import("../../src/queue/index.js");
    expect(initQueues()).toBe(0);
  });

  it("enqueue returns null (queue unavailable) when Redis is disabled", async () => {
    const { enqueue, QUEUE_NAMES } = await import("../../src/queue/index.js");
    const result = await enqueue(QUEUE_NAMES.SMOKE_TEST, "ping", {
      tenantId: "tenant-abc",
      message: "hello",
    });
    expect(result).toBeNull();
  });

  it("enqueue rejects unknown queue names", async () => {
    const { enqueue } = await import("../../src/queue/index.js");
    await expect(
      enqueue("not.a.queue", "ping", { tenantId: "t" }),
    ).rejects.toThrow(/unknown queue name/i);
  });

  it("enqueue requires a non-empty jobName", async () => {
    const { enqueue, QUEUE_NAMES } = await import("../../src/queue/index.js");
    await expect(
      enqueue(QUEUE_NAMES.SMOKE_TEST, "", { tenantId: "t" }),
    ).rejects.toThrow(/jobName is required/);
    await expect(
      enqueue(QUEUE_NAMES.SMOKE_TEST, undefined, { tenantId: "t" }),
    ).rejects.toThrow(/jobName is required/);
  });

  it("enqueue rejects payloads without tenantId (tenant isolation contract)", async () => {
    const { enqueue, QUEUE_NAMES } = await import("../../src/queue/index.js");
    await expect(
      enqueue(QUEUE_NAMES.SMOKE_TEST, "ping", { message: "no tenant" }),
    ).rejects.toThrow(/tenantId is required/);
    await expect(
      enqueue(QUEUE_NAMES.SMOKE_TEST, "ping", null),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("registerWorker rejects unknown queue names", async () => {
    const { registerWorker } = await import("../../src/queue/workers.js");
    expect(() => registerWorker("not.a.queue", () => {})).toThrow(
      /Unknown queue name/,
    );
  });

  it("registerWorker rejects non-function processors", async () => {
    const { registerWorker } = await import("../../src/queue/workers.js");
    const { QUEUE_NAMES } = await import("../../src/queue/queueNames.js");
    expect(() => registerWorker(QUEUE_NAMES.SMOKE_TEST, "not-a-fn")).toThrow(
      /must be a function/,
    );
  });

  it("registerWorker returns null when Redis is disabled", async () => {
    const { registerWorker } = await import("../../src/queue/workers.js");
    const { QUEUE_NAMES } = await import("../../src/queue/queueNames.js");
    const w = registerWorker(QUEUE_NAMES.SMOKE_TEST, async () => ({ ok: true }));
    expect(w).toBeNull();
  });

  afterEach(() => {
    if (ORIGINAL_REDIS_URL !== undefined) {
      process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    } else {
      delete process.env.REDIS_URL;
    }
  });
});

describe("BullMQ foundation — smoke-test processor", () => {
  it("rejects jobs without tenantId (tenant isolation contract)", async () => {
    const { processSmokeTest } = await import(
      "../../src/queue/processors/smokeTestProcessor.js"
    );
    await expect(
      processSmokeTest({ id: "j1", attemptsMade: 0, data: {} }),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("returns a structured result for a valid job", async () => {
    const { processSmokeTest } = await import(
      "../../src/queue/processors/smokeTestProcessor.js"
    );
    const result = await processSmokeTest({
      id: "j2",
      attemptsMade: 0,
      data: { tenantId: "tenant-1", message: "hi" },
    });
    expect(result.ok).toBe(true);
    expect(result.tenantId).toBe("tenant-1");
    expect(result.message).toBe("hi");
    expect(typeof result.processedAt).toBe("string");
  });
});
