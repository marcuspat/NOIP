# ADR-0014: Redis-backed sliding-window rate limiting

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** security, performance

## Context

Without a rate-limiting layer, NOIP is exposed to:

- Credential-stuffing on `/auth/login`.
- Account enumeration on `/auth/register` and password-reset flows.
- DoS on expensive endpoints (AI analysis, discovery scans).
- Compliance failures (most frameworks require throttling).

A correct rate-limit must:

1. Be coherent across replicas (an attacker cannot round-robin).
2. Not falsely throttle legitimate bursts at window boundaries.
3. Survive a Redis outage without taking the whole API down.

## Decision

We use **express-rate-limit** with a Redis store
(`src/middleware/rate-limit.middleware.ts`). Two policies apply:

- **Global**: 100 requests per IP per 15 minutes for the whole API.
- **Auth**: 5 requests per IP per 15 minutes for `/api/v1/auth/*`
  (login, register, refresh, MFA challenge, password reset).

Counters are **sliding-window** (Redis sorted set keyed by IP, members
are request timestamps; `ZRANGEBYSCORE` removes expired entries on each
hit). This avoids the bucket-boundary loophole of fixed windows.

When Redis is unavailable, the middleware **fails open** (allows the
request) but logs at `warn` and increments a Prometheus counter that
alerts the operator.

## Alternatives considered

- **In-process token bucket** (no Redis). Simple, but per-replica —
  attackers bypass by hitting different replicas.
- **Fixed-window counter.** Has a 2x burst problem at the boundary.
- **Cloudflare / API gateway only.** Useful as defence in depth but
  insufficient — internal callers and east-west traffic must also be
  throttled.

## Consequences

### Positive
- Coherent across all replicas.
- No bucket-boundary loophole.
- Fail-open keeps the API up during Redis blips, with loud telemetry.

### Negative / costs
- Each request is one Redis round-trip — measured at <1ms p99 in dev
  but adds budget on the hot path.
- Sorted-set memory grows with traffic — bounded by the 15-minute TTL.

### Risks and mitigations
- *Fail-open during prolonged Redis outage.* The accompanying alert
  is `Critical`; ops can engage WAF-level rate limiting in the
  meantime.
- *NAT users falsely throttled.* Auth window is per-IP+per-username
  rather than per-IP alone for `/auth/login` to reduce this.

## References

- `src/middleware/rate-limit.middleware.ts`
- `src/config/index.ts` — `RATE_LIMIT_*` env vars.
