# Orbinest - Backend API Server

## Security Hardening (v2.0)

This server includes a security hardening pass focused on tenant isolation and safer defaults.

| Area | Status |
| --- | --- |
| **BOLA / Tenant Isolation** | Mutating endpoints verify `tenantId` ownership |
| **File Access** | Files served through authenticated `/api/v1/files` routes |
| **RBAC** | Role checks enforced on state-changing routes |
| **CSRF** | Double-submit cookie pattern with `csrf-token` and `X-CSRF-Token` |
| **WebSocket Auth** | JWT tenant checks match HTTP protection behavior |
| **API Key** | Header-only extraction; Redis cache stores SHA-256 hashes |
| **Rate Limiting** | Per-route and global throttling via `express-rate-limit` |
| **Input Validation** | `express-validator` and `express-mongo-sanitize` enabled |
| **HTTP Headers** | Helmet with CSP, HSTS, and frame protections |

## Scripts

```bash
npm run dev
npm start
npm test
npm run test:coverage
npm run lint
npm run validate
```

## Environment Variables

See `.env.example` for required configuration.
