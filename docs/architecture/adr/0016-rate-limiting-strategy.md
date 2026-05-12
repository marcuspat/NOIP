# ADR-0016: Tiered rate limiting strategy

- **Status:** Accepted
- **Implementation:** Complete (Phase 1 wave 3 follow-up, 2026-05-12) — the auth router (`/api/auth/*`) now mounts `createBucketLimiter` per route group with explicit `auth` / `password-reset` / `mfa` buckets, all fail-CLOSED. The legacy `RateLimitMiddleware` class has been retired.
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, Security
- **Tags:** security, performance

## Context and Problem Statement

NOIP exposes APIs that are vulnerable to abuse: credential stuffing on
`/auth/login`, password-reset flooding, MFA brute force, AI-cost amplification
via `/api/ai/analyze/*`, and accidental DoS from misbehaving CI agents. Naive
single-bucket limits are too coarse.

The codebase already declares per-purpose limits in `src/config/index.ts`:
`security.rateLimit.{windowMs,max,authWindowMs,authMax,passwordResetWindowMs,
passwordResetMax,mfaWindowMs,mfaMax}`.

## Decision Drivers

- Specific limits per attack surface (login, MFA, password reset, generic API,
  AI endpoints).
- Distributed enforcement — limits are shared across all replicas.
- Predictable behaviour under partial Redis outage.
- Clear `429` response with `Retry-After` and structured error code.

## Considered Options

1. **`express-rate-limit` with a Redis store, multiple instances mounted per
   route group.**
2. **Cloud-provider rate limiting at the ingress / WAF.**
3. **Token-bucket per-IP using a custom middleware.**
4. **Hybrid: WAF + application limits.**

## Decision Outcome

**Chosen option:** **Hybrid — application-level `express-rate-limit` with
Redis store, plus optional WAF/Ingress limits at the edge** (Cloudflare /
Nginx Ingress) for L7 DDoS protection. Application limits are authoritative
for business logic; edge limits are the first wall.

### Buckets

| Bucket | Window | Max | Key |
|--------|--------|-----|-----|
| Global API | 15 min | 100 | `ip:<ip>` |
| Auth (`/auth/login`, `/auth/register`, `/auth/refresh`) | 15 min | 5 | `ip:<ip>` AND `user:<usernameOrEmail>` |
| Password reset (`/auth/password/reset`) | 1 h | 3 | `ip:<ip>` AND `email:<email>` |
| MFA verify (`/auth/mfa/verify`) | 5 min | 10 | `userId:<id>` |
| AI analysis (`/api/ai/analyze/*`) | 1 h | 60 | `userId:<id>` |

Each bucket is a separate `express-rate-limit` instance with `keyGenerator`
returning the appropriate composite key, backed by Redis under `noip:rl:*`.

### Failure modes

- **Redis available:** standard enforcement.
- **Redis unavailable:** middleware falls back to in-memory limit per pod;
  log a critical metric `noip_rate_limit_redis_unavailable_total`. We fail
  *open* for general API and *closed* for auth/MFA.

### Response shape

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{
  "error": "RATE_LIMIT_EXCEEDED",
  "bucket": "auth.login",
  "retryAfterSec": 42,
  "requestId": "..."
}
```

### Positive Consequences

- Bucket-specific protection against the relevant attack vector for each
  endpoint.
- Distributed enforcement (Redis-backed) survives horizontal scaling.

### Negative Consequences / Trade-offs

- Multiple middleware instances on the same router; the composition root
  in `src/app.ts` injects a `createBucketLimiter` factory into
  `createAuthRouter(...)` so each bucket is mounted exactly once and shared
  across the routes that belong to it.
- Composite keys (IP + user) require careful normalisation to avoid bypass.

## References

- `src/middleware/rate-limit-redis.ts` — `createBucketLimiter` factory + failure-mode wrapper.
- `src/routes/auth.routes.ts` — `createAuthRouter` factory, mounts the auth / password-reset / mfa buckets.
- `src/config/index.ts:security.rateLimit`
- ADR-0005 (Redis)
