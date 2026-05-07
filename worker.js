/**
 * Orbinest worker process entrypoint.
 *
 * Per CTO_BLUEPRINT.md §2 and ADR-006, BullMQ workers run in a dedicated
 * process so the API process stays lean and worker pods can scale per queue.
 * Run with: `npm run worker` (or `worker:dev` during development).
 */
import dotenv from "dotenv";
import http from "http";

dotenv.config();

import validateEnv from "./src/config/validateEnv.js";
validateEnv();

import logger from "./src/utils/logger.js";
import connectDB from "./src/config/db.js";
import { closeQueues, isBullConnectionEnabled } from "./src/queue/index.js";
import { bootstrapWorkers, closeWorkers } from "./src/queue/workers.js";

let isShuttingDown = false;
let healthServer = null;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} received — shutting down workers…`);

  if (healthServer) {
    try {
      healthServer.close();
    } catch (err) {
      logger.error(`Error closing worker health server: ${err.message}`);
    }
  }

  try {
    await closeWorkers();
  } catch (err) {
    logger.error(`Error closing workers: ${err.message}`);
  }
  try {
    await closeQueues();
  } catch (err) {
    logger.error(`Error closing queue connections: ${err.message}`);
  }
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connection.close();
  } catch (err) {
    logger.error(`Error closing MongoDB: ${err.message}`);
  }

  logger.info("Worker process shutdown complete");
  process.exit(0);
}

async function start() {
  if (!isBullConnectionEnabled()) {
    logger.error(
      "REDIS_URL is required to run the worker process. Refusing to start.",
    );
    process.exit(1);
  }

  await connectDB();
  logger.info("Worker MongoDB connected");

  const count = bootstrapWorkers();
  if (count === 0) {
    logger.error(
      "No workers registered (Redis unavailable). Refusing to stay up.",
    );
    process.exit(1);
  }

  const port = Number(process.env.WORKER_HEALTH_PORT) || 0;
  if (port > 0) {
    healthServer = http
      .createServer((req, res) => {
        if (req.url === "/health" || req.url === "/") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "ok", role: "worker", workers: count }),
          );
        } else {
          res.writeHead(404).end();
        }
      })
      .listen(port, () =>
        logger.info(`Worker health server listening on :${port}`),
      );
  }

  logger.info(`Orbinest worker process started (${count} worker(s))`);
}

process.on("uncaughtException", (err) => {
  logger.error(`Worker uncaught exception: ${err.stack || err.message}`);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  logger.error(
    `Worker unhandled rejection: ${err?.stack || err?.message || err}`,
  );
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  logger.error(`Failed to start worker process: ${err.message}`);
  process.exit(1);
});
