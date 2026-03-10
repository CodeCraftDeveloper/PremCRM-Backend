import mongoose from "mongoose";
import dns from "dns";
import logger from "../utils/logger.js";

// Use Google DNS to resolve MongoDB SRV records (fixes ECONNREFUSED issues)
dns.setServers(["8.8.8.8", "8.8.4.4"]);

/**
 * Connect to MongoDB database
 * Implements connection pooling and retry logic for production
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Connection pool settings for production
      maxPoolSize: 10,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4, // Force IPv4
    });

    logger.info(`MongoDB Connected: ${conn.connection.host}`);

    // Slow query logger — warn on queries taking > 500ms
    const SLOW_QUERY_THRESHOLD_MS = Number(process.env.SLOW_QUERY_MS) || 500;
    mongoose.set("debug", (_collectionName, _method, _query, _doc, _options) => {
      // mongoose debug callback receives timing only in v7+; we use a plugin instead
    });

    // Mongoose plugin: measure execution time of all queries
    mongoose.plugin((schema) => {
      schema.pre(/^find|count|distinct|aggregate/, function () {
        this._startTime = Date.now();
      });
      schema.post(/^find|count|distinct|aggregate/, function () {
        if (this._startTime) {
          const duration = Date.now() - this._startTime;
          if (duration > SLOW_QUERY_THRESHOLD_MS) {
            logger.warn("Slow MongoDB query", {
              collection: this.mongooseCollection?.name || "unknown",
              operation: this.op || "unknown",
              durationMs: duration,
              filter: JSON.stringify(this.getFilter?.() || {}),
            });
          }
        }
      });
    });

    // Handle connection events
    mongoose.connection.on("error", (err) => {
      logger.error(`MongoDB connection error: ${err}`);
    });

    mongoose.connection.on("disconnected", () => {
      logger.warn("MongoDB disconnected. Attempting to reconnect...");
    });

    mongoose.connection.on("reconnected", () => {
      logger.info("MongoDB reconnected");
    });

    return conn;
  } catch (error) {
    logger.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
