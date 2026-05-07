import IORedis from "ioredis";
import logger from "../utils/logger.js";

let connection = null;
let lastUrl = null;

/**
 * Build the BullMQ-compatible ioredis connection.
 *
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`
 * because it uses long-blocking commands (BRPOPLPUSH, etc.) that ioredis
 * would otherwise abort.
 *
 * Returns null when REDIS_URL is unset so the app degrades gracefully —
 * mirrors the behavior of `src/config/redis.js`.
 */
function buildConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const useTLS =
    process.env.REDIS_TLS === "true" || url.startsWith("rediss://");

  const opts = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  };
  if (useTLS) opts.tls = {};

  const client = new IORedis(url, opts);

  client.on("connect", () => logger.info("BullMQ Redis connecting…"));
  client.on("ready", () => logger.info("BullMQ Redis ready"));
  client.on("error", (err) =>
    logger.error(`BullMQ Redis error: ${err.message}`),
  );
  client.on("close", () => logger.warn("BullMQ Redis connection closed"));

  return client;
}

export function getBullConnection() {
  const url = process.env.REDIS_URL || null;
  if (connection && lastUrl === url) return connection;
  if (connection && lastUrl !== url) {
    try {
      connection.disconnect();
    } catch {
      // ignore
    }
    connection = null;
  }
  lastUrl = url;
  connection = buildConnection();
  return connection;
}

export async function closeBullConnection() {
  if (!connection) return;
  try {
    await connection.quit();
  } catch {
    try {
      connection.disconnect();
    } catch {
      // ignore
    }
  }
  connection = null;
  lastUrl = null;
}

export function isBullConnectionEnabled() {
  return Boolean(process.env.REDIS_URL);
}
