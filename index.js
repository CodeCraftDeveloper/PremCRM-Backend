import dotenv from "dotenv";
import http from "http";

// Load environment variables first
dotenv.config();

// Fail-fast: validate required env vars before anything else
import validateEnv from "./src/config/validateEnv.js";
validateEnv(); // throws if critical vars are missing

import app from "./app.js";
import connectDB from "./src/config/db.js";
import { initRedis, getRedisClient } from "./src/config/redis.js";
import { initQueues, closeQueues } from "./src/queue/index.js";
import { initializeSocketServer } from "./src/socket/index.js";
import logger from "./src/utils/logger.js";

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION! Shutting down...");
  logger.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});

const PORT = process.env.PORT || 5000;

// ── Graceful-shutdown helper ─────────────────────────────────
let isShuttingDown = false;

const gracefulShutdown = (signal, server) => {
  if (isShuttingDown) return; // prevent double-fire
  isShuttingDown = true;
  logger.info(`${signal} received — starting graceful shutdown…`);

  // 1. Stop accepting new connections
  server.close(async () => {
    logger.info("HTTP server closed");

    try {
      // 2. Close MongoDB
      const mongoose = (await import("mongoose")).default;
      await mongoose.connection.close();
      logger.info("MongoDB connection closed");
    } catch (e) {
      logger.error(`Error closing MongoDB: ${e.message}`);
    }

    try {
      // 3. Close BullMQ queues + ioredis connection (if any)
      await closeQueues();
      logger.info("BullMQ queues closed");
    } catch (e) {
      logger.error(`Error closing BullMQ: ${e.message}`);
    }

    try {
      // 4. Close Redis (if connected)
      const client = getRedisClient();
      if (client) {
        await client.quit();
        logger.info("Redis connection closed");
      }
    } catch (e) {
      logger.error(`Error closing Redis: ${e.message}`);
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  });

  // Force-kill after 10 s if connections refuse to drain
  setTimeout(() => {
    logger.error("Shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000).unref();
};

// ── Start server ─────────────────────────────────────────────
const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();
    logger.info("MongoDB connected successfully");

    // Initialize Redis (optional — app works without it)
    try {
      await initRedis();
      logger.info("Redis initialized");
    } catch (redisError) {
      logger.warn("Redis connection failed - continuing without cache");
    }

    // Initialize BullMQ queue handles. The API process only enqueues —
    // workers run in `worker.js`. Safe no-op when REDIS_URL is unset.
    try {
      initQueues();
    } catch (queueError) {
      logger.warn(`BullMQ init failed: ${queueError.message}`);
    }

    // Start Express server with Socket.IO
    const httpServer = http.createServer(app);
    const socketIO = initializeSocketServer(httpServer);

    // Make socket.io instance available to the app
    app.set("socketio", socketIO);

    const server = httpServer.listen(PORT, () => {
      logger.info(
        `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`,
      );
      logger.info(`API Documentation: http://localhost:${PORT}/api`);
      logger.info(`Health Check: http://localhost:${PORT}/api/health`);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (err) => {
      logger.error("UNHANDLED REJECTION! Shutting down...");
      logger.error(err.name, err.message);
      gracefulShutdown("unhandledRejection", server);
    });

    // Graceful shutdown on signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM", server));
    process.on("SIGINT", () => gracefulShutdown("SIGINT", server));
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
