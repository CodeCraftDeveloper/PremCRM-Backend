/**
 * Tests for the P2-002 Queue Failure & DLQ Tracking slice.
 *
 * Coverage:
 *   1. NonRetryableError class shape + isNonRetryableError detection
 *   2. RETRY_POLICIES per-queue overrides + getResolvedJobOptions merge
 *   3. isTerminalFailure decision logic (exhausted vs in-flight vs non-retryable)
 *   4. FailedJob model persistence (tenant-scoped indexes, basic write)
 *   5. recordFailedJob writes the audit doc and returns null when payload
 *      is missing tenantId
 *   6. queueStatusService.getQueueCounts graceful degradation
 *   7. queueStatusService.getRecentFailedJobs filters and tenant scoping
 *   8. GET /api/v1/queues/status — superadmin only
 *   9. GET /api/v1/queues/failed-jobs — own-tenant scoping for admin,
 *      cross-tenant for superadmin
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let app;
let request;

let Tenant;
let User;
let FailedJob;

function makeToken(userId, tenantId, role = "admin") {
  return jwt.sign(
    { id: userId.toString(), tenantId: tenantId.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function createTenantCtx(slug, plan = "growth", role = "admin") {
  const tenant = await Tenant.create({
    name: `Tenant ${slug}`,
    slug,
    isActive: true,
    plan,
  });
  const user = await User.create({
    name: `User ${slug}`,
    email: `${slug}@example.com`,
    password: "Password123!",
    role,
    tenantId: tenant._id,
    isActive: true,
    approvalStatus: "approved",
  });
  const token = makeToken(user._id, tenant._id, role);
  return { tenant, user, token };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const appModule = await import("../../app.js");
  app = appModule.default;

  const supertest = await import("supertest");
  request = supertest.default(app);

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  FailedJob = (await import("../../src/models/FailedJob.js")).default;
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

describe("queue/errors — NonRetryableError", () => {
  it("is detected by isNonRetryableError and carries an optional details payload", async () => {
    const { NonRetryableError, isNonRetryableError, UnrecoverableError } =
      await import("../../src/queue/errors.js");

    const err = new NonRetryableError("bad input", { field: "tenantId" });
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.name).toBe("NonRetryableError");
    expect(err.nonRetryable).toBe(true);
    expect(err.details).toEqual({ field: "tenantId" });
    expect(isNonRetryableError(err)).toBe(true);

    expect(isNonRetryableError(new Error("transient"))).toBe(false);
    expect(isNonRetryableError(null)).toBe(false);
  });
});

describe("queue/retryPolicies — per-queue overrides", () => {
  it("returns the partial policy for a known queue and {} for unknown queues", async () => {
    const { getRetryPolicy, RETRY_POLICIES } = await import(
      "../../src/queue/retryPolicies.js"
    );
    const { QUEUE_NAMES } = await import("../../src/queue/queueNames.js");

    expect(Object.isFrozen(RETRY_POLICIES)).toBe(true);
    expect(getRetryPolicy(QUEUE_NAMES.BILLING_METER).attempts).toBe(10);
    expect(getRetryPolicy(QUEUE_NAMES.AI_DRAFT).attempts).toBe(3);
    expect(getRetryPolicy(QUEUE_NAMES.GMAIL_SYNC).attempts).toBe(8);

    // smoke.test stays on defaults
    expect(getRetryPolicy(QUEUE_NAMES.SMOKE_TEST)).toEqual({});
    expect(getRetryPolicy("not.a.queue")).toEqual({});
  });

  it("merges per-queue overrides on top of DEFAULT_JOB_OPTIONS via getResolvedJobOptions", async () => {
    const { getResolvedJobOptions, DEFAULT_JOB_OPTIONS } = await import(
      "../../src/queue/registry.js"
    );
    const { QUEUE_NAMES } = await import("../../src/queue/queueNames.js");

    const billing = getResolvedJobOptions(QUEUE_NAMES.BILLING_METER);
    expect(billing.attempts).toBe(10); // override
    expect(billing.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff); // inherited
    expect(billing.removeOnFail.age).toBe(30 * 24 * 60 * 60); // override

    const smoke = getResolvedJobOptions(QUEUE_NAMES.SMOKE_TEST);
    expect(smoke.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
  });
});

describe("queue/failedJobRecorder — terminal-failure detection", () => {
  it("isTerminalFailure: false when attempts remain, true when exhausted", async () => {
    const { isTerminalFailure } = await import(
      "../../src/queue/failedJobRecorder.js"
    );
    const err = new Error("boom");

    expect(
      isTerminalFailure(
        { attemptsMade: 1, opts: { attempts: 5 }, data: { tenantId: "t" } },
        err,
      ),
    ).toBe(false);

    expect(
      isTerminalFailure(
        { attemptsMade: 5, opts: { attempts: 5 }, data: { tenantId: "t" } },
        err,
      ),
    ).toBe(true);
  });

  it("isTerminalFailure: true on first attempt when error is NonRetryableError", async () => {
    const { isTerminalFailure } = await import(
      "../../src/queue/failedJobRecorder.js"
    );
    const { NonRetryableError } = await import("../../src/queue/errors.js");

    expect(
      isTerminalFailure(
        { attemptsMade: 1, opts: { attempts: 5 }, data: { tenantId: "t" } },
        new NonRetryableError("validation"),
      ),
    ).toBe(true);
  });

  it("recordFailedJob persists a doc with payload + reason and skips when tenantId missing", async () => {
    const { recordFailedJob } = await import(
      "../../src/queue/failedJobRecorder.js"
    );
    const { NonRetryableError } = await import("../../src/queue/errors.js");

    const job = {
      id: "j-1",
      name: "send",
      attemptsMade: 5,
      opts: { attempts: 5 },
      data: { tenantId: "tenant-abc", subject: "hi" },
    };
    const doc = await recordFailedJob({
      queueName: "smoke.test",
      job,
      err: new NonRetryableError("bad payload"),
    });

    expect(doc).not.toBeNull();
    expect(doc.tenantId).toBe("tenant-abc");
    expect(doc.queueName).toBe("smoke.test");
    expect(doc.jobName).toBe("send");
    expect(doc.attemptsMade).toBe(5);
    expect(doc.maxAttempts).toBe(5);
    expect(doc.failedReason).toBe("bad payload");
    expect(doc.nonRetryable).toBe(true);
    expect(doc.payload.subject).toBe("hi");
    expect(doc.status).toBe("failed");

    const persisted = await FailedJob.findById(doc._id);
    expect(persisted).not.toBeNull();

    // Tenant-isolation: jobs without tenantId in payload are NOT recorded.
    const skip = await recordFailedJob({
      queueName: "smoke.test",
      job: { id: "j-2", name: "send", attemptsMade: 1, opts: { attempts: 1 }, data: {} },
      err: new Error("missing tenant"),
    });
    expect(skip).toBeNull();
  });
});

describe("queue/queueStatusService — graceful degradation & failed-job query", () => {
  it("getQueueCounts returns enabled:false when REDIS_URL is empty", async () => {
    const { getQueueCounts } = await import(
      "../../src/queue/queueStatusService.js"
    );
    const result = await getQueueCounts();
    expect(result.enabled).toBe(false);
    expect(Array.isArray(result.queues)).toBe(true);
    // Each row exposes the resolved attempts even when Redis is off
    const billing = result.queues.find((q) => q.name === "billing.meter");
    expect(billing.attempts).toBe(10);
    expect(billing.error).toBe("redis-disabled");
    expect(billing.counts).toBeNull();
  });

  it("getRecentFailedJobs filters by tenant + queue and respects limit cap", async () => {
    const { getRecentFailedJobs } = await import(
      "../../src/queue/queueStatusService.js"
    );

    await FailedJob.create([
      {
        tenantId: "tenant-a",
        queueName: "ai.draft",
        jobName: "draft",
        jobId: "1",
        attemptsMade: 3,
        maxAttempts: 3,
        failedReason: "rate limit",
        payload: { tenantId: "tenant-a" },
        failedAt: new Date(Date.now() - 1000),
      },
      {
        tenantId: "tenant-a",
        queueName: "gmail.sync",
        jobName: "sync",
        jobId: "2",
        attemptsMade: 8,
        maxAttempts: 8,
        failedReason: "timeout",
        payload: { tenantId: "tenant-a" },
        failedAt: new Date(),
      },
      {
        tenantId: "tenant-b",
        queueName: "ai.draft",
        jobName: "draft",
        jobId: "3",
        attemptsMade: 3,
        maxAttempts: 3,
        failedReason: "schema",
        payload: { tenantId: "tenant-b" },
        failedAt: new Date(),
      },
    ]);

    const aOnly = await getRecentFailedJobs({ tenantId: "tenant-a" });
    expect(aOnly).toHaveLength(2);
    expect(aOnly.every((d) => d.tenantId === "tenant-a")).toBe(true);

    const aiOnly = await getRecentFailedJobs({ queueName: "ai.draft" });
    expect(aiOnly).toHaveLength(2);
    expect(aiOnly.every((d) => d.queueName === "ai.draft")).toBe(true);

    const aAi = await getRecentFailedJobs({
      tenantId: "tenant-a",
      queueName: "ai.draft",
    });
    expect(aAi).toHaveLength(1);
    expect(aAi[0].jobId).toBe("1");

    const capped = await getRecentFailedJobs({ limit: 5000 });
    expect(capped.length).toBeLessThanOrEqual(200);

    // Sort order is failedAt DESC
    const all = await getRecentFailedJobs({});
    expect(new Date(all[0].failedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(all[all.length - 1].failedAt).getTime(),
    );
  });
});

describe("GET /api/v1/queues/status", () => {
  it("rejects non-superadmins (admin gets 403)", async () => {
    const ctx = await createTenantCtx("queue-status-admin", "growth", "admin");
    const res = await request
      .get("/api/v1/queues/status")
      .set("Authorization", `Bearer ${ctx.token}`);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request.get("/api/v1/queues/status");
    expect(res.status).toBe(401);
  });

  it("returns 200 + per-queue rows for a superadmin", async () => {
    const ctx = await createTenantCtx(
      "queue-status-super",
      "enterprise",
      "superadmin",
    );
    const res = await request
      .get("/api/v1/queues/status")
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.enabled).toBe(false); // REDIS_URL is empty in tests
    expect(Array.isArray(res.body.data.queues)).toBe(true);
    expect(res.body.data.queues.length).toBeGreaterThan(0);
    const billing = res.body.data.queues.find(
      (q) => q.name === "billing.meter",
    );
    expect(billing.attempts).toBe(10);
  });
});

describe("GET /api/v1/queues/failed-jobs", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request.get("/api/v1/queues/failed-jobs");
    expect(res.status).toBe(401);
  });

  it("admin: scoped to own tenant — cross-tenant tenantId param is ignored", async () => {
    const a = await createTenantCtx("dlq-tenant-a", "growth", "admin");
    const b = await createTenantCtx("dlq-tenant-b", "growth", "admin");

    await FailedJob.create([
      {
        tenantId: String(a.tenant._id),
        queueName: "ai.draft",
        jobName: "draft",
        jobId: "a1",
        payload: {},
        failedAt: new Date(),
      },
      {
        tenantId: String(b.tenant._id),
        queueName: "ai.draft",
        jobName: "draft",
        jobId: "b1",
        payload: {},
        failedAt: new Date(),
      },
    ]);

    const res = await request
      .get(`/api/v1/queues/failed-jobs?tenantId=${b.tenant._id}`)
      .set("Authorization", `Bearer ${a.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.scope).toEqual({
      type: "tenant",
      tenantId: String(a.tenant._id),
    });
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.items[0].jobId).toBe("a1");
  });

  it("superadmin: no tenant filter returns system-wide; with ?tenantId scopes to that tenant", async () => {
    const a = await createTenantCtx("dlq-sa-a", "growth", "admin");
    const b = await createTenantCtx("dlq-sa-b", "growth", "admin");
    const sa = await createTenantCtx(
      "dlq-sa-sa",
      "enterprise",
      "superadmin",
    );

    await FailedJob.create([
      {
        tenantId: String(a.tenant._id),
        queueName: "ai.draft",
        jobName: "x",
        jobId: "a1",
        payload: {},
        failedAt: new Date(),
      },
      {
        tenantId: String(b.tenant._id),
        queueName: "ai.draft",
        jobName: "x",
        jobId: "b1",
        payload: {},
        failedAt: new Date(),
      },
    ]);

    const all = await request
      .get("/api/v1/queues/failed-jobs")
      .set("Authorization", `Bearer ${sa.token}`);
    expect(all.status).toBe(200);
    expect(all.body.data.scope).toEqual({ type: "system" });
    expect(all.body.data.count).toBe(2);

    const scoped = await request
      .get(`/api/v1/queues/failed-jobs?tenantId=${b.tenant._id}`)
      .set("Authorization", `Bearer ${sa.token}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.scope).toEqual({
      type: "tenant",
      tenantId: String(b.tenant._id),
    });
    expect(scoped.body.data.count).toBe(1);
    expect(scoped.body.data.items[0].jobId).toBe("b1");
  });

  it("rejects unknown queueName filter with 400", async () => {
    const ctx = await createTenantCtx("dlq-bad-q", "growth", "admin");
    const res = await request
      .get("/api/v1/queues/failed-jobs?queueName=not.a.queue")
      .set("Authorization", `Bearer ${ctx.token}`);
    expect(res.status).toBe(400);
  });

  it("rejects unknown status filter with 400", async () => {
    const ctx = await createTenantCtx("dlq-bad-s", "growth", "admin");
    const res = await request
      .get("/api/v1/queues/failed-jobs?status=open")
      .set("Authorization", `Bearer ${ctx.token}`);
    expect(res.status).toBe(400);
  });
});
