import crypto from "crypto";
import Website from "../models/Website.js";
import { ApiError } from "../utils/apiResponse.js";
import logger from "../utils/logger.js";
import redis, { isRedisConnected } from "../config/redis.js";

const localRateLimitStore = new Map();

const getLocalRateCounter = (websiteId) => {
  const key = String(websiteId);
  const now = Date.now();
  const minuteWindowStart = now - 60 * 1000;
  const dayWindowStart = now - 24 * 60 * 60 * 1000;

  const existing = localRateLimitStore.get(key) || { minute: [], day: [] };
  existing.minute = existing.minute.filter((ts) => ts >= minuteWindowStart);
  existing.day = existing.day.filter((ts) => ts >= dayWindowStart);

  localRateLimitStore.set(key, existing);
  return existing;
};

/**
 * Middleware to validate API key for public lead intake endpoints
 * Extracts and validates API key from headers or body
 * Attaches website data to req.website
 */
export const validateApiKey = async (req, res, next) => {
  try {
    // Get API key from header or body
    const apiKey =
      req.headers["x-api-key"] ||
      req.headers["authorization"]?.replace("Bearer ", "") ||
      req.body?.apiKey;

    if (!apiKey) {
      logger.warn(`Lead API: Missing API key from ${req.ip}`);
      return next(ApiError.unauthorized("API key is required"));
    }

    // Check Redis cache first (cache for 5 minutes)
    const cacheKey = `api_key:${apiKey}`;
    let website = await redis.get(cacheKey);

    if (website) {
      website = JSON.parse(website);
    } else {
      // Query database
      website = await Website.findOne(
        { apiKey, isActive: true },
        "tenantId name domain category stats rateLimit webhookUrl ipWhitelist apiKeyPrefix",
      ).lean();

      if (!website) {
        logger.warn(
          `Lead API: Invalid API key attempted from ${req.ip}: ${apiKey.substring(0, 8)}...`,
        );
        return next(ApiError.unauthorized("Invalid or inactive API key"));
      }

      // Cache for 5 minutes
      await redis.setex(cacheKey, 300, JSON.stringify(website));
    }

    // Attach to request
    req.website = website;
    req.tenantId = website.tenantId;

    next();
  } catch (error) {
    logger.error(`API key validation error: ${error.message}`);
    next(error);
  }
};

/**
 * Middleware to check rate limits for public API
 * Uses Redis for distributed rate limiting
 */
export const leadRateLimit = async (req, res, next) => {
  try {
    if (!req.website) {
      return next(ApiError.badRequest("Website not identified"));
    }

    const websiteId = req.website._id;
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Redis keys for rate limiting (use websiteId as unique identifier)
    const minuteKey = `rate_limit:${websiteId}:minute`;
    const dayKey = `rate_limit:${websiteId}:day`;

    const rateLimit = req.website.rateLimit || {};
    const maxPerMinute = rateLimit.requestsPerMinute || 60;
    const maxPerDay = rateLimit.requestsPerDay || 5000;
    const redisAvailable = isRedisConnected();

    let minuteCount = 0;
    let dayCount = 0;

    if (redisAvailable) {
      minuteCount = await redis.zcount(minuteKey, oneMinuteAgo, now);
      dayCount = await redis.zcount(dayKey, oneDayAgo, now);
    } else {
      const localCounter = getLocalRateCounter(websiteId);
      minuteCount = localCounter.minute.length;
      dayCount = localCounter.day.length;
    }

    if (minuteCount >= maxPerMinute) {
      logger.warn(
        `Lead API: Rate limit exceeded (per minute) for ${req.website.name}`,
      );
      return next(
        ApiError.tooManyRequests(
          `Rate limit exceeded: ${maxPerMinute} requests per minute`,
        ),
      );
    }

    if (dayCount >= maxPerDay) {
      logger.warn(
        `Lead API: Rate limit exceeded (per day) for ${req.website.name}`,
      );
      return next(
        ApiError.tooManyRequests(
          `Rate limit exceeded: ${maxPerDay} requests per day`,
        ),
      );
    }

    if (redisAvailable) {
      // Add current request to Redis (score = timestamp)
      await redis.zadd(minuteKey, now, `${now}-${Math.random()}`);
      await redis.zadd(dayKey, now, `${now}-${Math.random()}`);

      // Set expiry
      await redis.expire(minuteKey, 60);
      await redis.expire(dayKey, 24 * 60 * 60);
    } else {
      const localCounter = getLocalRateCounter(websiteId);
      localCounter.minute.push(now);
      localCounter.day.push(now);
    }

    // Attach rate limit info to response headers
    res.setHeader("X-RateLimit-Limit", maxPerMinute);
    res.setHeader("X-RateLimit-Remaining", maxPerMinute - minuteCount - 1);
    res.setHeader("X-RateLimit-Reset", new Date(now + 60 * 1000).toISOString());

    next();
  } catch (error) {
    logger.error(`Rate limit check error: ${error.message}`);
    next(ApiError.tooManyRequests("Rate limit service unavailable"));
  }
};

/**
 * Middleware to validate IP whitelist for website
 */
export const validateIpWhitelist = async (req, res, next) => {
  try {
    if (!req.website) {
      return next();
    }

    const { ipWhitelist } = req.website;

    if (ipWhitelist && ipWhitelist.length > 0) {
      const clientIp = req.ip || req.connection?.remoteAddress;

      if (!ipWhitelist.includes(clientIp)) {
        logger.warn(
          `Lead API: IP not whitelisted for ${req.website.name}: ${clientIp}`,
        );
        return next(
          ApiError.forbidden("Your IP is not whitelisted for this API"),
        );
      }
    }

    next();
  } catch (error) {
    logger.error(`IP whitelist validation error: ${error.message}`);
    // Don't block if validation fails
    next();
  }
};

/**
 * Middleware to log public API requests
 */
export const logPublicApiRequest = async (req, res, next) => {
  try {
    const startTime = Date.now();

    // Log after response
    res.on("finish", async () => {
      const duration = Date.now() - startTime;

      logger.info(`Public Lead API: ${req.method} ${req.path}`, {
        website: req.website?.name || "unknown",
        apiKeyPrefix: req.website?.apiKeyPrefix || "unknown",
        status: res.statusCode,
        ip: req.ip,
        duration: `${duration}ms`,
        userAgent: req.get("user-agent"),
      });
    });

    next();
  } catch (error) {
    // Silently fail, don't block request
    next();
  }
};

/**
 * Verify webhook signature for outgoing webhooks
 */
export const verifyWebhookSignature = (secret) => {
  return (req, res, next) => {
    const signature = req.headers["x-webhook-signature"];

    if (!signature) {
      return next(ApiError.unauthorized("Missing webhook signature"));
    }

    const payload = JSON.stringify(req.body);
    const hash = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    if (hash !== signature) {
      return next(ApiError.unauthorized("Invalid webhook signature"));
    }

    next();
  };
};
