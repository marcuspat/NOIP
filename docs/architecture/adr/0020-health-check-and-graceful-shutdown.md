# ADR-0020: Health checks and graceful shutdown

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, SRE
- **Tags:** ops, reliability

## Context and Problem Statement

Kubernetes uses `livenessProbe`, `readinessProbe`, and `startupProbe` to make
pod-level decisions. The application also receives `SIGTERM` during pod
eviction or rolling deploys; in-flight HTTP requests, AI calls, and Mongo
sessions must be drained.

The codebase has a `/health` endpoint (`src/app.ts`) that aggregates per-
service health checks, and graceful shutdown handlers for `SIGTERM` /
`SIGINT`.

## Decision Drivers

- Distinguish *can the pod accept traffic now* (readiness) from *is the pod
  fundamentally broken* (liveness).
- Avoid restart storms when MongoDB or Redis blip.
- Drain HTTP and Redis/Mongo connections cleanly during shutdown.

## Considered Options

1. **Three probes: `/health/startup`, `/health/ready`, `/health/live` plus a
   composite `/health` for humans.**
2. **Single `/health` endpoint reused by all probes.**

## Decision Outcome

**Chosen option:** Option 1.

### Endpoint semantics

| Endpoint | Returns 200 when | Returns non-200 when |
|----------|------------------|----------------------|
| `/health/live` | The process is responsive (event loop not stuck). | Process should be killed and restarted. |
| `/health/ready` | All required dependencies (Mongo, Redis) are reachable AND startup completed. | Pod should not receive traffic. |
| `/health/startup` | Bootstrap (config validation, migrations) finished. | Kubernetes waits before checking liveness. |
| `/health` | Composite, human-friendly (existing `src/app.ts`). | — |

### Probe configuration (k8s)

```yaml
startupProbe:
  httpGet: { path: /health/startup, port: 3000 }
  failureThreshold: 30
  periodSeconds: 5
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 5
  failureThreshold: 3
```

### Graceful shutdown sequence

On `SIGTERM`:

1. Mark `ready=false` so Kubernetes stops sending traffic.
2. Stop scheduled scanners (`DiscoveryService.stop()`,
   `SecurityService.stop()`, etc.).
3. Wait `terminationGracePeriodSeconds - 5s` (default 25s) for in-flight HTTP
   requests to finish (`http.Server.close`).
4. Close MongoDB and Redis connections.
5. Flush logs and exit `0`.

A hard timeout (`SHUTDOWN_HARD_TIMEOUT_MS=30000`) forces exit if step 3
hangs.

### Positive Consequences

- Avoids dropping in-flight requests during deploys.
- Prevents misleading 200s when dependencies are down.
- Aligns with Kubernetes best practices.

### Negative Consequences / Trade-offs

- Slightly more complex code paths than a single endpoint.

## References

- `src/app.ts:/health`, `SIGTERM` / `SIGINT` handlers.
- ADR-0014 (Kubernetes-native deployment)
