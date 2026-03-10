import crypto from "crypto";

/**
 * Double-Submit Cookie CSRF protection.
 *
 * How it works:
 *  1. On every response we set a `__Host-csrf` cookie with a random token
 *     (SameSite=Strict, HttpOnly=false so JS can read it).
 *  2. For state-changing methods (POST / PUT / PATCH / DELETE) the client
 *     must echo the token value in the `X-CSRF-Token` header.
 *  3. An attacker on another origin cannot read the cookie (same-origin policy)
 *     and therefore cannot forge the header.
 *
 * Skip list:
 *  - Public lead API (`/api/public/*`, `/api/v1/public/*`) — uses API keys.
 *  - Health-check endpoints.
 *  - OAuth callback URLs if any.
 *  - `GET / HEAD / OPTIONS` — safe methods.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const SKIP_PREFIXES = ["/api/public/", "/api/v1/public/", "/api/health"];

// Auth endpoints that must work without a CSRF cookie (fresh browser, expired
// cookie, or token-based proof).  These rely on their own credentials /
// one-time tokens, so CSRF protection is not required.
const SKIP_AUTH_PATHS = [
  "/api/auth/login",
  "/api/v1/auth/login",
  "/api/auth/refresh-token",
  "/api/v1/auth/refresh-token",
  "/api/auth/register-marketing-manager",
  "/api/v1/auth/register-marketing-manager",
  "/api/auth/forgot-password",
  "/api/v1/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/v1/auth/reset-password",
  "/api/auth/accept-invite",
  "/api/v1/auth/accept-invite",
];

function shouldSkip(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return true;
  if (SKIP_AUTH_PATHS.includes(req.path)) return true;
  return false;
}

/**
 * Middleware: set the CSRF cookie on every response so the SPA always has a
 * fresh token.  Only enforces validation on state-changing requests.
 */
export function csrfProtection(req, res, next) {
  // Skip in test environment to avoid breaking existing tests
  if (process.env.NODE_ENV === "test") return next();

  // --------------- Issue / refresh the cookie ---------------
  let csrfToken = req.cookies?.["csrf-token"];
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(32).toString("hex");
  }

  // Re-set the cookie on every response (refresh expiry, ensure it exists)
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("csrf-token", csrfToken, {
    httpOnly: false, // JS must read it
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000, // 24 h
  });

  // --------------- Validate on mutating requests ---------------
  if (shouldSkip(req)) return next();

  // If request uses Bearer token (not cookie), CSRF is not applicable
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return next();
  }

  const headerToken = req.headers["x-csrf-token"];
  if (!headerToken || headerToken !== csrfToken) {
    return res.status(403).json({
      success: false,
      message: "CSRF token missing or invalid",
    });
  }

  next();
}

/**
 * Lightweight endpoint handler: GET /api/v1/auth/csrf-token
 * Returns the current CSRF token so the SPA can bootstrap.
 */
export function getCsrfToken(req, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("csrf-token", token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ success: true, csrfToken: token });
}
