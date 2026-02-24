import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
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
} from "./src/routes/index.js";

// Import middlewares
import { errorHandler, notFound } from "./src/middlewares/error.js";
import { apiLimiter } from "./src/middlewares/rateLimiter.js";

// Import utilities
import logger from "./src/utils/logger.js";

// Initialize express app
const app = express();

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
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
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
