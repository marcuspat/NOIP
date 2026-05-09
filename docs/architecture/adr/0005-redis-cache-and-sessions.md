# ADR-0005: Redis for cache, sessions, and rate-limit counters

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering
- **Tags:** persistence, caching, sessions

## Context and Problem Statement

Several NOIP workloads require sub-millisecond, ephemeral, high-throughput
storage that does not belong in MongoDB:

- **Rate-limit counters** for global, auth, MFA, and password-reset endpoints
  (`src/middleware/rate-limit.middleware.ts`).
- **Session lookups** by `sessionId` and refresh-token jti.
- **Token revocation lists** (JWT denylist) until token natural expiry.
- **MFA challenge state** (TOTP windows, SMS/email code TTL).
- **Hot caches** for cluster scan results and dashboard widget data.

Persisting these in MongoDB would inflate write IOPS and add latency.

## Decision Drivers

- Sub-millisecond latency for token validation on every API call.
- TTL-based eviction (sessions, codes, denylist entries).
- Cluster-aware operation under Kubernetes.
- A library that supports ioredis cluster mode and Sentinel.

## Considered Options

1. **Redis (`ioredis` client)** — current direction.
2. **In-process LRU caches** — simplest, but not cluster-aware.
3. **Memcached** — no persistence, fewer data types.
4. **Hazelcast / KeyDB** — niche, smaller ecosystem.

## Decision Outcome

**Chosen option:** **Redis** deployed as a Kubernetes StatefulSet
(`k8s/database/redis-statefulset.yaml`), accessed via `ioredis` with cluster
support behind a feature flag (`REDIS_CLUSTER_ENABLED`).

Redis namespaces (key prefixes):

| Prefix | Owner | Purpose | TTL |
|--------|-------|---------|-----|
| `noip:rl:*` | rate-limit middleware | sliding-window counters | window |
| `noip:sess:*` | IAM | session id → user id, device fingerprint | session timeout |
| `noip:rt:*` | IAM | refresh-token jti → metadata | refresh expiry |
| `noip:deny:*` | IAM | revoked access-token jti | until token exp |
| `noip:mfa:*` | IAM | pending TOTP / SMS / email challenges | code expiry |
| `noip:cache:*` | various | computed scan/widget snapshots | per-key |

### Positive Consequences

- Cheap, predictable session and token lookups.
- TTL handling is native; no scheduler required for cleanup.
- Same Redis instance can back rate limiting, sessions, and caches without
  fan-out.

### Negative Consequences / Trade-offs

- New operational dependency; loss of Redis impacts auth and rate limiting.
  Mitigation: replicas, Sentinel/cluster mode, and degraded-mode behaviour
  (fail-closed for auth, fail-open with logging for rate limiting).
- Memory pressure if TTLs are mis-tuned; we use `allkeys-lru` as the
  `maxmemory-policy` (`config/redis.maxMemoryPolicy`).

## Pros and Cons of the Options

### Redis

- 👍 Mature, ubiquitous, predictable latency.
- 👍 First-class TTL semantics and pub/sub for cache invalidation.
- 👎 Operational dependency.

### In-process LRU

- 👍 Zero dependency.
- 👎 Inconsistent across replicas; no shared rate limiting; lost on restart.

### Memcached

- 👍 Simple, fast.
- 👎 No persistence, no rich data structures, no cluster-friendly counters.

### Hazelcast / KeyDB

- 👍 Multi-master variants exist.
- 👎 Smaller ecosystem and fewer Node.js client guarantees.

## References

- `src/database/redis.ts`
- `src/middleware/rate-limit.middleware.ts`
- `k8s/database/redis-statefulset.yaml`
- ADR-0016 (rate-limit strategy)
