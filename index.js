import dotenv from "dotenv";
import http from "http";

// Load environment variables first
dotenv.config();

import app from "./app.js";
import connectDB from "./src/config/db.js";
import { initRedis } from "./src/config/redis.js";
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

// Start server
const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();
    logger.info("MongoDB connected successfully");

    // Initialize Redis (optional - app works without it)
    try {
      await initRedis();
      logger.info("Redis initialized");
    } catch (redisError) {
      logger.warn("Redis connection failed - continuing without cache");
    }

    // Start Express server with Socket.IO
    const httpServer = http.createServer(app);
    initializeSocketServer(httpServer);

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
      server.close(() => {
        process.exit(1);
      });
    });

    // Handle SIGTERM
    process.on("SIGTERM", () => {
      logger.info("SIGTERM received. Shutting down gracefully...");
      server.close(() => {
        logger.info("Process terminated");
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
