import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";

// Import routes
import {
  authRoutes,
  userRoutes,
  eventRoutes,
  clientRoutes,
  remarkRoutes,
  dashboardRoutes,
  exportRoutes,
  sessionRoutes,
  publicLeadRoutes,
  leadRoutes,
  websiteRoutes,
  tenantRoutes,
  superAdminRoutes,
  ticketRoutes,
  fileRoutes,
} from "./src/routes/index.js";
import crmRoutes from "./src/routes/crm/index.js";

// Import middlewares
import { errorHandler, notFound } from "./src/middlewares/error.js";
import { apiLimiter } from "./src/middlewares/rateLimiter.js";
import requestIdMiddleware from "./src/middlewares/requestId.js";
import { requestDuration } from "./src/middlewares/requestDuration.js";
import {
  trackApiUsage,
  trackActiveUser,
} from "./src/middlewares/usageTracker.js";

// Import CSRF protection
import { csrfProtection } from "./src/middlewares/csrf.js";

// Import utilities
import logger from "./src/utils/logger.js";

// Initialize express app
const app = express();

// Attach a unique requestId to every request (must be first)
app.use(requestIdMiddleware);

// Track request duration & log slow requests
app.use(requestDuration);
const normalizeOrigin = (value = "") =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\/+$/, "")
    .toLowerCase();

const envOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

const devOrigins =
  process.env.NODE_ENV === "development"
    ? ["http://localhost:5173", "http://localhost:3000"].map(normalizeOrigin)
    : [];

const allowedOrigins = [...new Set([...envOrigins, ...devOrigins])];

// =====================
// Security Middlewares
// =====================

// Disable x-powered-by (before helmet, so it's definitely gone)
app.disable("x-powered-by");

// Set security HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    frameguard: { action: "deny" },
    hsts: {
      maxAge: 31_536_000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    xssFilter: true,
  }),
);

// Enable CORS
app.use(
  cors((req, callback) => {
    const isPublicApiRoute =
      req.path?.startsWith("/api/public/") ||
      req.path?.startsWith("/api/v1/public/");

    const baseOptions = {
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Request-Id",
        "X-CSRF-Token",
        "x-api-key",
      ],
      exposedHeaders: [
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
      ],
    };

    // Public lead API: allow all browser origins; API key still protects access.
    if (isPublicApiRoute) {
      return callback(null, {
        ...baseOptions,
        origin: true,
        credentials: false,
      });
    }

    return callback(null, {
      ...baseOptions,
      credentials: true,
      origin: (origin, originCallback) => {
        if (!origin) return originCallback(null, true);
        const normalizedOrigin = normalizeOrigin(origin);
        if (allowedOrigins.includes(normalizedOrigin)) {
          return originCallback(null, true);
        }
        return originCallback(new Error(`CORS blocked for origin: ${origin}`));
      },
    });
  }),
);

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Sanitize data against NoSQL injection.
// express-mongo-sanitize reassigns req.query, which throws on Express 5.
app.use((req, res, next) => {
  ["body", "params", "headers", "query"].forEach((key) => {
    if (req[key]) {
      mongoSanitize.sanitize(req[key]);
    }
  });
  next();
});

// Rate limiting
app.use("/api/", apiLimiter);

// =====================
// General Middlewares
// =====================

// Body parser
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// Compression
app.use(compression());

// CSRF double-submit cookie protection (after cookieParser, before routes)
app.use(csrfProtection);

// Logging
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(
    morgan("combined", {
      stream: {
        write: (message) => logger.info(message.trim()),
      },
    }),
  );
}

// SECURITY: Static file serving removed — files served through authenticated /api/v1/files route
// app.use(express.static("public")); // REMOVED: was exposing uploads without auth

// =====================
// Health Check
// =====================
import mongoose from "mongoose";
import { isRedisConnected } from "./src/config/redis.js";

app.get("/api/health", (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const redisReady = isRedisConnected();
  const healthy = dbReady; // Redis is optional

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage().rss,
    services: {
      database: dbReady ? "connected" : "disconnected",
      redis: redisReady ? "connected" : "disconnected",
    },
  });
});

app.get("/api/health/db", async (req, res) => {
  try {
    const admin = mongoose.connection.db.admin();
    const result = await admin.ping();
    const ok = result?.ok === 1;
    res.status(ok ? 200 : 503).json({
      success: ok,
      service: "mongodb",
      status: ok ? "connected" : "unreachable",
      readyState: mongoose.connection.readyState,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      service: "mongodb",
      status: "unreachable",
      error: err.message,
    });
  }
});

app.get("/api/health/redis", async (req, res) => {
  const redisReady = isRedisConnected();
  if (!redisReady) {
    return res.status(503).json({
      success: false,
      service: "redis",
      status: "disconnected",
    });
  }

  try {
    const { getRedisClient } = await import("./src/config/redis.js");
    const client = getRedisClient();
    await client.ping();
    res.status(200).json({
      success: true,
      service: "redis",
      status: "connected",
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      service: "redis",
      status: "error",
      error: err.message,
    });
  }
});

// =====================
// API Routes — v1 (canonical) + backward-compat alias
// =====================

// Track API usage per tenant (non-blocking, after auth is resolved in routes)
app.use("/api/", trackApiUsage);
app.use("/api/", trackActiveUser);

// v1 canonical prefix
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/events", eventRoutes);
app.use("/api/v1/clients", clientRoutes);
app.use("/api/v1/remarks", remarkRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);
app.use("/api/v1/export", exportRoutes);
app.use("/api/v1/sessions", sessionRoutes);
app.use("/api/v1/public", publicLeadRoutes);
app.use("/api/v1/leads", leadRoutes);
app.use("/api/v1/websites", websiteRoutes);
app.use("/api/v1/tenants", tenantRoutes);
app.use("/api/v1/superadmin", superAdminRoutes);
app.use("/api/v1/tickets", ticketRoutes);
app.use("/api/v1/files", fileRoutes);
app.use("/api/v1/crm", crmRoutes);

// Backward-compat: /api/* → same handlers (no redirect, no duplication)
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/remarks", remarkRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/public", publicLeadRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/websites", websiteRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/crm", crmRoutes);

// =====================
// API Documentation
// =====================

app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "CRM API v1.0",
    documentation: {
      auth: {
        "POST /api/auth/login": "Login user",
        "POST /api/auth/refresh-token": "Refresh access token",
        "POST /api/auth/logout": "Logout user",
        "GET /api/auth/me": "Get current user",
        "PUT /api/auth/me": "Update profile",
        "PUT /api/auth/change-password": "Change password",
        "POST /api/auth/forgot-password": "Request password reset",
        "POST /api/auth/reset-password/:token": "Reset password",
      },
      users: {
        "GET /api/users": "Get all users (Admin)",
        "POST /api/users": "Create user (Admin)",
        "GET /api/users/:id": "Get user by ID (Admin)",
        "PUT /api/users/:id": "Update user (Admin)",
        "DELETE /api/users/:id": "Delete user (Admin)",
        "GET /api/users/marketing": "Get marketing users",
      },
      events: {
        "GET /api/events": "Get all events",
        "GET /api/events/active": "Get active events",
        "POST /api/events": "Create event (Admin)",
        "GET /api/events/:id": "Get event by ID",
        "GET /api/events/:id/stats": "Get event statistics",
        "PUT /api/events/:id": "Update event (Admin)",
        "DELETE /api/events/:id": "Delete event (Admin)",
      },
      clients: {
        "GET /api/clients": "Get all clients",
        "POST /api/clients": "Create client",
        "GET /api/clients/:id": "Get client by ID",
        "PUT /api/clients/:id": "Update client",
        "DELETE /api/clients/:id": "Delete client (soft)",
        "PUT /api/clients/:id/restore": "Restore deleted client (Admin)",
        "POST /api/clients/:id/visiting-card": "Upload visiting card",
        "GET /api/clients/:clientId/remarks": "Get client remarks",
        "POST /api/clients/:clientId/remarks": "Add client remark",
        "GET /api/clients/:clientId/timeline": "Get client timeline",
        "GET /api/clients/stats": "Get client statistics",
        "GET /api/clients/follow-ups/pending": "Get pending follow-ups",
      },
      dashboard: {
        "GET /api/dashboard/admin": "Get admin dashboard (Admin)",
        "GET /api/dashboard/marketing": "Get marketing dashboard",
        "GET /api/dashboard/analytics": "Get analytics (Admin)",
      },
      export: {
        "GET /api/export/summary": "Get export options",
        "GET /api/export/clients": "Export clients CSV",
        "GET /api/export/events": "Export events CSV (Admin)",
        "GET /api/export/activity-logs": "Export logs CSV (Admin)",
      },
      sessions: {
        "GET /api/sessions/marketing/status":
          "Get marketing users online status (Admin)",
        "GET /api/sessions/marketing/performance":
          "Get marketing users performance metrics (Admin)",
        "GET /api/sessions/marketing/:userId/report":
          "Get detailed user report (Admin)",
      },
      "public-leads": {
        "POST /api/public/lead": "Submit lead from external website",
        "GET /api/public/health": "Health check endpoint",
        "GET /api/public/docs": "API documentation",
      },
      leads: {
        "GET /api/leads": "Get all leads with filters",
        "POST /api/leads": "Create lead manually (Admin/Marketing)",
        "GET /api/leads/:id": "Get lead details",
        "PUT /api/leads/:id": "Update lead (Admin/Marketing)",
        "PUT /api/leads/:id/status": "Update lead status",
        "PUT /api/leads/:id/assign": "Assign lead to user (Admin)",
        "PUT /api/leads/:id/mark-duplicate": "Mark lead as duplicate (Admin)",
        "POST /api/leads/:id/merge/:duplicateId":
          "Merge duplicate leads (Admin)",
        "DELETE /api/leads/:id": "Delete lead (Admin, soft)",
        "PUT /api/leads/:id/restore": "Restore deleted lead (Admin)",
        "GET /api/leads/unassigned/count": "Count unassigned leads",
        "POST /api/leads/auto-assign":
          "Auto-assign all unassigned leads (Admin)",
        "GET /api/leads/analytics/dashboard": "Get lead analytics",
      },
      websites: {
        "GET /api/websites": "Get all websites",
        "POST /api/websites": "Create website (Admin)",
        "GET /api/websites/:id": "Get website details",
        "PUT /api/websites/:id": "Update website (Admin)",
        "DELETE /api/websites/:id": "Delete website (Admin)",
        "POST /api/websites/:id/regenerate-key": "Regenerate API key (Admin)",
        "GET /api/websites/:id/stats": "Get website statistics",
        "POST /api/websites/:id/test": "Test webhook connection",
      },
      tenants: {
        "POST /api/tenants/bootstrap": "Create tenant + first admin",
        "GET /api/tenants": "List tenants (admin/superadmin)",
        "GET /api/tenants/:id": "Get tenant details",
        "PUT /api/tenants/:id": "Update tenant settings",
      },
      tickets: {
        "GET /api/tickets": "Get all tickets with filters",
        "POST /api/tickets": "Create ticket (Admin/Marketing)",
        "GET /api/tickets/stats": "Get ticket statistics",
        "GET /api/tickets/follow-ups": "Get upcoming follow-ups",
        "GET /api/tickets/entity/:entityType/:entityId":
          "Get tickets by entity",
        "GET /api/tickets/:id": "Get ticket details",
        "PUT /api/tickets/:id": "Update ticket",
        "PUT /api/tickets/:id/status": "Update ticket status",
        "PUT /api/tickets/:id/assign": "Assign ticket (Admin)",
        "DELETE /api/tickets/:id": "Delete ticket (Admin, soft)",
        "PUT /api/tickets/:id/restore": "Restore deleted ticket (Admin)",
        "PUT /api/tickets/bulk/status": "Bulk update status (Admin)",
        "PUT /api/tickets/bulk/assign": "Bulk assign tickets (Admin)",
        "GET /api/tickets/:ticketId/remarks": "Get ticket remarks",
        "POST /api/tickets/:ticketId/remarks": "Add ticket remark",
        "PUT /api/tickets/remarks/:id": "Update remark",
        "DELETE /api/tickets/remarks/:id": "Delete remark",
      },
      crm: {
        contacts: {
          "GET /api/crm/contacts": "List contacts",
          "GET /api/crm/contacts/:id": "Get contact",
          "POST /api/crm/contacts": "Create contact",
          "PUT /api/crm/contacts/:id": "Update contact",
          "DELETE /api/crm/contacts/:id": "Delete contact (soft)",
          "PATCH /api/crm/contacts/:id/restore": "Restore contact",
          "PATCH /api/crm/contacts/:id/assign": "Assign contact owner",
        },
        accounts: {
          "GET /api/crm/accounts": "List accounts",
          "POST /api/crm/accounts": "Create account",
          "PUT /api/crm/accounts/:id": "Update account",
          "DELETE /api/crm/accounts/:id": "Delete account (soft)",
        },
        deals: {
          "GET /api/crm/deals": "List deals",
          "POST /api/crm/deals": "Create deal",
          "PUT /api/crm/deals/:id": "Update deal",
          "PATCH /api/crm/deals/:id/stage": "Change deal stage",
          "DELETE /api/crm/deals/:id": "Delete deal (soft)",
        },
        activities: {
          "GET /api/crm/activities": "List activities",
          "GET /api/crm/activities/entity/:type/:id":
            "Get activities for entity",
          "POST /api/crm/activities": "Create activity",
          "PUT /api/crm/activities/:id": "Update activity",
        },
        pipelines: {
          "GET /api/crm/pipelines": "List pipelines",
          "POST /api/crm/pipelines": "Create pipeline (Admin)",
          "PUT /api/crm/pipelines/:id/stages": "Update pipeline stages (Admin)",
        },
        leadConversion: {
          "POST /api/crm/leads/:id/convert":
            "Convert lead to Contact+Account+Deal",
        },
        workflows: {
          "GET /api/crm/workflows/rules": "List automation rules",
          "POST /api/crm/workflows/rules": "Create rule (Admin)",
          "GET /api/crm/workflows/executions": "List executions (Admin)",
        },
        blueprints: {
          "GET /api/crm/blueprints": "List blueprints",
          "POST /api/crm/blueprints": "Create blueprint (Admin)",
          "POST /api/crm/blueprints/validate": "Validate transition",
        },
        analytics: {
          "GET /api/crm/analytics/snapshot": "CRM dashboard snapshot",
          "GET /api/crm/analytics/funnel/:pipelineId": "Deal funnel",
          "GET /api/crm/analytics/lead-source": "Lead source performance",
          "GET /api/crm/analytics/owner-performance":
            "Owner performance (Admin)",
          "GET /api/crm/analytics/stage-duration/:pipelineId": "Stage duration",
        },
      },
    },
  });
});

// =====================
// Error Handling
// =====================

// Handle 404
app.use(notFound);

// Global error handler
app.use(errorHandler);

export default app;
