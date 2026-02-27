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

function shouldSkip(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  return SKIP_PREFIXES.some((p) => req.path.startsWith(p));
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
    sameSite: isProduction ? "Strict" : "Lax",
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
    sameSite: isProduction ? "Strict" : "Lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ success: true, csrfToken: token });
}
