import { Worker } from "bullmq";
import { getBullConnection } from "./connection.js";
import { BULLMQ_PREFIX } from "./registry.js";
import { QUEUE_NAMES, isKnownQueueName } from "./queueNames.js";
import { processSmokeTest } from "./processors/smokeTestProcessor.js";
import { processWorkflowExecute } from "./processors/workflowExecuteProcessor.js";
import { processInboundWebhook } from "./processors/inboundWebhookProcessor.js";
import { processGmailSync } from "./processors/gmailSyncProcessor.js";
import { processWhatsappMessage } from "./processors/whatsappMessageProcessor.js";
import { processAiDraft } from "./processors/aiDraftProcessor.js";
import { processGmbReviews } from "./processors/gmbReviewProcessor.js";
import {
  isTerminalFailure,
  recordFailedJob,
} from "./failedJobRecorder.js";
import logger from "../utils/logger.js";

const workers = new Map();

/**
 * Map of queue name → processor function.
 *
 * Future phases register their processor here. Workers are only bootstrapped
 * for the queues listed in this registry, so the worker process can run with
 * a known concurrency budget per queue.
 */
export const PROCESSORS = Object.freeze({
  [QUEUE_NAMES.SMOKE_TEST]: processSmokeTest,
  [QUEUE_NAMES.WORKFLOW_EXECUTE]: processWorkflowExecute,
  [QUEUE_NAMES.INBOUND_WEBHOOKS]: processInboundWebhook,
  [QUEUE_NAMES.GMAIL_SYNC]: processGmailSync,
  [QUEUE_NAMES.WHATSAPP_MESSAGES]: processWhatsappMessage,
  [QUEUE_NAMES.AI_DRAFT]: processAiDraft,
  [QUEUE_NAMES.GMB_REVIEWS]: processGmbReviews,
});

const DEFAULT_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY) || 5;

export function registerWorker(queueName, processor, options = {}) {
  if (!isKnownQueueName(queueName)) {
    throw new Error(`Unknown queue name: ${queueName}`);
  }
  if (typeof processor !== "function") {
    throw new Error(`Processor for ${queueName} must be a function`);
  }
  if (workers.has(queueName)) return workers.get(queueName);

  const connection = getBullConnection();
  if (!connection) {
    logger.warn(
      `BullMQ disabled (REDIS_URL not set); cannot register worker for ${queueName}`,
    );
    return null;
  }

  const worker = new Worker(queueName, processor, {
    connection,
    prefix: BULLMQ_PREFIX,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    autorun: options.autorun ?? true,
    ...options,
  });

  worker.on("completed", (job) =>
    logger.info(
      `Job ${queueName}/${job.name} (${job.id}) completed in ${
        job.processedOn && job.finishedOn
          ? job.finishedOn - job.processedOn
          : "?"
      }ms`,
    ),
  );
  worker.on("failed", async (job, err) => {
    logger.error(
      `Job ${queueName}/${job?.name ?? "?"} (${job?.id ?? "?"}) failed (attempt ${
        job?.attemptsMade ?? 0
      }/${job?.opts?.attempts ?? "?"}): ${err.message}`,
    );
    if (isTerminalFailure(job, err)) {
      await recordFailedJob({ queueName, job, err });
    }
  });
  worker.on("error", (err) =>
    logger.error(`Worker ${queueName} error: ${err.message}`),
  );

  workers.set(queueName, worker);
  logger.info(`BullMQ worker registered for ${queueName}`);
  return worker;
}

export function bootstrapWorkers() {
  let count = 0;
  for (const [queueName, processor] of Object.entries(PROCESSORS)) {
    if (registerWorker(queueName, processor)) count += 1;
  }
  logger.info(`BullMQ worker bootstrap complete: ${count} worker(s) running`);
  return count;
}

export function getRegisteredWorker(queueName) {
  return workers.get(queueName) || null;
}

export async function closeWorkers() {
  const entries = Array.from(workers.entries());
  workers.clear();
  for (const [name, w] of entries) {
    try {
      await w.close();
    } catch (err) {
      logger.error(`Error closing worker ${name}: ${err.message}`);
    }
  }
}
