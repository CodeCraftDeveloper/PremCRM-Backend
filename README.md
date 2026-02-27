# PremCRM — Backend API Server

## Security Hardening (v2.0)

This server has undergone a comprehensive security audit and hardening pass.
Key improvements:

| Area                        | Status                                                                           |
| --------------------------- | -------------------------------------------------------------------------------- |
| **BOLA / Tenant Isolation** | All mutating endpoints verify `tenantId` ownership                               |
| **File Access**             | Static serving removed; files served through authenticated `/api/v1/files` route |
| **RBAC**                    | `authorize()` middleware enforced on all state-changing routes                   |
| **CSRF**                    | Double-submit cookie pattern (`csrf-token` cookie + `X-CSRF-Token` header)       |
| **WebSocket Auth**          | JWT tenant match + tenant active check (parity with HTTP `protect`)              |
| **API Key**                 | Header-only extraction; Redis cache uses SHA-256 hash of key                     |
| **Rate Limiting**           | Per-route + global via `express-rate-limit`                                      |
| **Input Validation**        | `express-validator` on all routes; `express-mongo-sanitize` globally             |
| **HTTP Headers**            | Helmet with strict CSP, HSTS, X-Frame-Options DENY                               |

## Scripts

```bash
npm run dev           # Start with nodemon (development)
npm start             # Start production server
npm test              # Run vitest test suite
npm run test:coverage # Run tests with coverage report
npm run lint          # ESLint check
npm run validate      # Lint + test in one command
```

## Environment Variables

See `.env.example` for required configuration. Key secrets:

- `JWT_SECRET` / `JWT_REFRESH_SECRET` — Token signing
- `MONGO_URI` — MongoDB connection string
- `REDIS_URL` — Redis connection (optional, gracefully degrades)
- `CORS_ORIGIN` — Comma-separated allowed origins
