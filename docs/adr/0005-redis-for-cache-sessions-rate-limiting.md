# ADR-0005: Redis for cache, sessions, and rate limiting

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** cache, sessions, rate-limiting

## Context

NOIP runs as multiple stateless replicas behind a load balancer. Several
concerns cannot be solved cleanly in-process:

1. **Refresh-token / session store** — the auth context needs to revoke
   sessions instantly across all replicas when a user logs out, rotates a
   refresh token, or is forced out by an admin.
2. **Rate limiting** — per-IP and per-user counters must be coherent across
   replicas; a brute-force attempt cannot just round-robin to a fresh
   counter.
3. **Hot-path caching** — discovery snapshots, compliance score computations
   and AI analysis results are expensive to produce and cheap to memoise.
4. **Pub/Sub** — for in-process invalidation between replicas (e.g. evicting
   a user's permission cache when a role changes).

## Decision

We use **Redis 7** (single primary in dev, replicated with sentinel/cluster
in production) as the canonical store for:

- Refresh tokens / session metadata (with TTL = refresh-token lifetime).
- Sliding-window rate-limit counters
  (see [ADR-0014](./0014-rate-limiting-redis-backed-sliding-window.md)).
- Short-TTL caches of expensive reads.
- Pub/sub channels for cross-replica cache invalidation.

We use the **ioredis** client (`ioredis ^5.8.2`). Connection lifecycle
lives in `src/database/redis.ts`.

## Alternatives considered

- **In-process LRU only** — fast, but breaks horizontal scaling: each
  replica has its own view, sessions cannot be revoked instantly, and rate
  limits are per-replica.
- **Memcached** — pure cache, lacks the data structures (sorted sets for
  sliding windows, streams for pub/sub) we rely on.
- **MongoDB-backed sessions** — possible but adds load to the same store
  used for durable data; TTL semantics in Mongo are coarser (60s sweep)
  than what auth needs.

## Consequences

### Positive
- Coherent rate-limit and session view across all replicas.
- O(log n) sliding-window with sorted sets; O(1) cache hit path.
- TTL is first-class — no cron sweep needed for expiry.

### Negative / costs
- One more piece of infrastructure to operate (HA, backups, alerting).
- We must treat Redis as ephemeral: anything we cannot afford to lose
  goes to MongoDB. Refresh tokens are recoverable (force re-login) but
  not session-attached audit data.

### Risks and mitigations
- *Redis outage takes down logins.* Auth gracefully degrades reads to
  MongoDB; rate-limit middleware fails *open* on Redis errors but logs
  loudly so the operator notices.
- *Memory exhaustion.* `maxmemory` + `allkeys-lru` for cache namespace;
  session keys live in a separate logical DB with eviction disabled.

## References

- `src/database/redis.ts` — connection and helpers.
- `src/middleware/rate-limit.middleware.ts` — usage for rate limiting.
- `k8s/redis-statefulset.yaml` — production topology.
