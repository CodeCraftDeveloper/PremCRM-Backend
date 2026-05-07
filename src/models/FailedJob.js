import mongoose from "mongoose";

/**
 * FailedJob — durable audit record of a terminally-failed BullMQ job.
 *
 * BullMQ keeps failed jobs in Redis for `removeOnFail.age` (default 7 days).
 * That's enough for live replay tooling, but operational triage and
 * compliance audit need a longer record-of-truth that survives Redis flush.
 * This collection is that record.
 *
 * Written by the worker process via `failedJobRecorder.js` when a job
 * exhausts its attempts (or is thrown as NonRetryableError, which BullMQ
 * treats as immediate exhaustion).
 *
 * Tenant isolation: `tenantId` is required and indexed first; queries from
 * non-superadmins must scope by `tenantId`. The value is stored as a string
 * to accommodate both ObjectId-string tenants and any future non-Mongo
 * tenant ID format.
 *
 * Status lifecycle (manual operations, no automatic transitions):
 *   - "failed"    — initial state on terminal failure
 *   - "replayed"  — operator manually re-enqueued the job
 *   - "discarded" — operator chose not to replay (won't-fix)
 */
const failedJobSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
    },
    queueName: {
      type: String,
      required: true,
    },
    jobName: {
      type: String,
      required: true,
    },
    jobId: {
      type: String,
      required: true,
    },
    attemptsMade: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 0,
    },
    failedReason: {
      type: String,
      default: "",
    },
    stackTrace: {
      type: String,
      default: "",
    },
    nonRetryable: {
      type: Boolean,
      default: false,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    failedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    status: {
      type: String,
      enum: ["failed", "replayed", "discarded"],
      default: "failed",
    },
    replayedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

failedJobSchema.index({ tenantId: 1, failedAt: -1 });
failedJobSchema.index({ queueName: 1, failedAt: -1 });
failedJobSchema.index({ status: 1, failedAt: -1 });

// 30-day TTL on the audit log. Increase per-tenant or per-queue if compliance
// requires longer retention; billing.meter especially may want longer.
failedJobSchema.index(
  { failedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

const FailedJob = mongoose.model("FailedJob", failedJobSchema);

export default FailedJob;
