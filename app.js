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
} from "./src/routes/index.js";

// Import middlewares
import { errorHandler, notFound } from "./src/middlewares/error.js";
import { apiLimiter } from "./src/middlewares/rateLimiter.js";

// Import utilities
import logger from "./src/utils/logger.js";

// Initialize express app
const app = express();
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

// Set security HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Enable CORS
app.use(
  cors((req, callback) => {
    const isPublicApiRoute = req.path?.startsWith("/api/public/");

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

// Static files
app.use(express.static("public"));

// =====================
// Health Check
// =====================

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// =====================
// API Routes
// =====================

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
        "DELETE /api/clients/:id": "Delete client",
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
        "DELETE /api/leads/:id": "Delete lead (Admin)",
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
