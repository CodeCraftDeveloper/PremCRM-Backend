import { createClient } from "redis";
import logger from "../utils/logger.js";

let redisClient = null;
let isConnected = false;

/**
 * Initialize Redis client with connection handling
 * Supports both Upstash (dev with TLS) and AWS ElastiCache (production)
 */
const initRedis = async () => {
  try {
    const redisUrl = process.env.REDIS_URL;
    const useTLS =
      process.env.REDIS_TLS === "true" || redisUrl?.startsWith("rediss://");

    const clientConfig = {
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error("Redis: Max reconnection attempts reached");
            return new Error("Max reconnection attempts reached");
          }
          return Math.min(retries * 100, 3000);
        },
      },
    };

    // Enable TLS for Upstash and other cloud providers
    if (useTLS) {
      clientConfig.socket.tls = true;
    }

    redisClient = createClient(clientConfig);

    redisClient.on("connect", () => {
      logger.info("Redis client connecting...");
    });

    redisClient.on("ready", () => {
      isConnected = true;
      logger.info("Redis client connected and ready");
    });

    redisClient.on("error", (err) => {
      isConnected = false;
      logger.error(`Redis Client Error: ${err.message}`);
    });

    redisClient.on("end", () => {
      isConnected = false;
      logger.warn("Redis client disconnected");
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    logger.error(`Redis connection error: ${error.message}`);
    // Don't exit - app can run without Redis
    return null;
  }
};

/**
 * Get cached data from Redis
 * @param {string} key - Cache key
 * @returns {Promise<any>} Parsed cached data or null
 */
const getCache = async (key) => {
  try {
    if (!isConnected || !redisClient) return null;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logger.error(`Redis GET error for key ${key}: ${error.message}`);
    return null;
  }
};

/**
 * Set data in Redis cache
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in seconds (default: 1 hour)
 */
const setCache = async (key, data, ttl = 3600) => {
  try {
    if (!isConnected || !redisClient) return false;
    await redisClient.setEx(key, ttl, JSON.stringify(data));
    return true;
  } catch (error) {
    logger.error(`Redis SET error for key ${key}: ${error.message}`);
    return false;
  }
};

/**
 * Delete cached data from Redis
 * @param {string} key - Cache key or pattern
 */
const deleteCache = async (key) => {
  try {
    if (!isConnected || !redisClient) return false;
    await redisClient.del(key);
    return true;
  } catch (error) {
    logger.error(`Redis DELETE error for key ${key}: ${error.message}`);
    return false;
  }
};

/**
 * Delete multiple keys matching a pattern
 * @param {string} pattern - Key pattern (e.g., 'clients:*')
 */
const deleteCachePattern = async (pattern) => {
  try {
    if (!isConnected || !redisClient) return false;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    return true;
  } catch (error) {
    logger.error(`Redis DELETE PATTERN error for ${pattern}: ${error.message}`);
    return false;
  }
};

/**
 * Get Redis client instance
 */
const getRedisClient = () => redisClient;

/**
 * Check if Redis is connected
 */
const isRedisConnected = () => isConnected;

export {
  initRedis,
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  getRedisClient,
  isRedisConnected,
};
