# RUNBOOK — NetOps Intelligence Platform (NOIP)

Operational playbook for running NOIP in production. Covers boot order,
shutdown sequence, health-probe semantics, the most common failure modes,
JWT-secret rotation, audit-chain integrity checks, scaling, and backup /
restore.

For install paths see [`docs/INSTALL.md`](./INSTALL.md). For the test
matrix see [`docs/TESTING.md`](./TESTING.md). Cross-cutting decisions
that shape the operational surface are recorded as ADRs under
[`docs/architecture/adr/`](./architecture/adr/).

---

## Pod boot order

The composition root in [`src/app.ts`](../src/app.ts) bootstraps in this
order. Each step blocks until the previous one completes; if any step
throws, the process exits non-zero and Kubernetes restarts the pod.

1. **Config validation** —
   [`src/config/validation.ts`](../src/config/validation.ts) runs at
   import time (ADR-0019). It rejects placeholder secrets, short JWT
   keys, and unsafe CORS combinations in production. The process throws
   before the HTTP listener is created.
2. **Shared Redis client** — single ioredis instance (ADR-0005) used by
   the JWT denylist, refresh-token families, permission cache, MFA
   challenges, rate-limit counters, and sessions. The client connects
   lazily; connection errors surface on the first use, not at construct.
3. **EventBus + audit subscribers** — the in-process EventBus (ADR-0018)
   plus its audit subscribers are wired before any context is
   constructed, so that domain events emitted during bootstrap are
   captured by the audit log.
4. **Bounded contexts** — IAM, Discovery, Security, AI, Performance,
   Dashboard, and Audit are constructed through their `api/index.ts`
   barrels. Construction order follows the dependency graph in
   [`docs/architecture/ddd/04-context-map.md`](./architecture/ddd/04-context-map.md):
   IAM first, then Discovery / Security / AI / Performance / Dashboard
   (which depend on IAM), then Audit (which subscribes to events from
   everyone else).
5. **HTTP routes mounted** — `/metrics` and `/health/{live,ready,startup}`
   first (so probes work even if the rate limiter or auth middleware
   later misbehave), then the rate limiter, then the protected routes.
6. **Startup complete** — `/health/startup` flips to 200. Kubernetes can
   now route traffic; `/health/ready` will return 200 as soon as the
   dependency probes succeed.

Logs at INFO level narrate each step; a healthy boot prints a final
`startup complete` line with the elapsed milliseconds.

---

## Graceful shutdown (ADR-0020)

SIGTERM and SIGINT both invoke the same `gracefulShutdown()` handler in
[`src/app.ts`](../src/app.ts). The sequence:

1. Set `shuttingDown = true`. `/health/ready` immediately starts
   returning 503 so Kubernetes stops routing new traffic to this pod.
   `/health/live` stays 200 (the pod is healthy, it's just shutting
   down — we do not want the kubelet to SIGKILL us).
2. Stop scheduled scanners and cron jobs (Discovery + Security
   schedulers).
3. Stop accepting new HTTP connections; existing requests are allowed
   to drain.
4. Disconnect from MongoDB and the shared Redis client.
5. Process exits 0.

A hard timeout (`SHUTDOWN_HARD_TIMEOUT_MS`, default **30 000 ms**) caps
the whole sequence. If the timeout fires, the process exits 1 — the
kubelet then restarts it, which is acceptable because new traffic was
already drained at step 1.

Kubernetes-side tuning to match:

```yaml
terminationGracePeriodSeconds: 45   # > SHUTDOWN_HARD_TIMEOUT_MS / 1000
preStop:
  exec:
    command: ["sleep", "5"]         # let kube-proxy drain endpoints first
```

---

## Health probe semantics (ADR-0020)

Three probes, each with a single, well-defined meaning:

| Endpoint | 200 means | 503 means | Kubernetes probe |
|----------|-----------|-----------|-------------------|
| `GET /health/live` | The process can accept syscalls. | The pod should be killed; kubelet will restart it. | `livenessProbe` |
| `GET /health/startup` | The composition root finished bootstrapping (config validated, subscribers installed, Redis connected). | Boot has not finished yet. | `startupProbe` |
| `GET /health/ready` | Startup is done AND all required dependencies (Mongo, Redis, Discovery, Security, AI, Performance, Compliance services) are healthy AND we are not shutting down. | Stop routing traffic to this pod. | `readinessProbe` |

There is also `GET /health` (composite human payload) for ops
dashboards — do NOT wire it to a Kubernetes probe.

Recommended probe configuration:

```yaml
startupProbe:
  httpGet: { path: /health/startup, port: 3000 }
  failureThreshold: 30
  periodSeconds: 2
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 5
```

---

## Common failure modes

Triage table covering the failures most likely to wake an on-call
engineer. Every row lists the symptom, the underlying cause, and the
remediation.

### Redis outage — auth fails closed

- **Symptom:** `/api/auth/*` returns 5xx; `noip_authz_checks_total{outcome="error"}`
  spikes; logs show `RedisConnectionError` from `JWTManager`.
- **Cause:** Redis is the source of truth for the JWT denylist,
  refresh-token families, the RBAC permission cache, MFA challenges,
  and rate-limit counters (ADR-0005). When Redis is unreachable the
  auth path fails **closed** by design — we cannot honour token
  revocation without it.
- **Remediation:** restore Redis. While impaired, scale read-only
  consumers (e.g. dashboard pulls) to ride out the outage; admins can
  bypass via direct DB queries on Mongo, not via the API.

### AI cost breach — 429 from `/api/ai/*`

- **Symptom:** `/api/ai/*` returns 429 with `X-RateLimit-Reason: cost-guard`;
  `noip_ai_cost_guard_blocks_total` increments.
- **Cause:** the Anthropic adapter's cost guard (ADR-0012) has crossed
  the per-window USD budget configured via `AI_COST_BUDGET_USD` /
  `AI_COST_WINDOW_SECONDS`.
- **Remediation:** review the cost dashboard; raise the budget
  intentionally via the env override or wait for the window to roll.
  Do not disable the guard — it is the only thing protecting against a
  runaway prompt loop.

### kube-apiserver throttle — degraded scans

- **Symptom:** Discovery snapshot counts plateau; logs show
  `429 Too Many Requests` from the Kubernetes client; the
  `noip_kubernetes_requests_total{status="429"}` counter rises.
- **Cause:** the Discovery context is hitting the kube-apiserver
  faster than its priority-and-fairness queue tolerates.
- **Remediation:** raise `SCAN_INTERVAL` (default 300 000 ms) for
  Discovery; if the cluster has many namespaces, also reduce
  `DISCOVERY_BATCH_SIZE`. Long-term, ask the cluster admin to widen
  the PriorityLevelConfiguration for the service account.

### Boot loop on `validateConfig` failure

- **Symptom:** the process exits 1 within milliseconds of start; the
  kubelet reports `CrashLoopBackOff`; logs show `Configuration invalid`.
- **Cause:** ADR-0019 — `validateConfig()` refuses to start with a
  placeholder JWT secret, a short JWT secret (< 32 chars), or an empty
  CORS allow-list in production.
- **Remediation:** check the rendered env on the failing pod
  (`kubectl exec -- env | sort`) against the rules in
  [`src/config/validation.ts`](../src/config/validation.ts). Fix the
  upstream `ExternalSecret`; do not lower the validator.

### Audit-chain hash mismatch

- **Symptom:** `noip_audit_persist_failed_total` increments; the
  audit-chain integrity check (below) reports a broken link.
- **Cause:** ADR-0017 — the append-only audit log is hash-chained.
  A mismatch means either a write to the collection bypassed the
  service (manual `db.collection.insert`) or storage was tampered
  with.
- **Remediation:** rotate the audit collection (archive the old one
  under `audits-broken-<date>`, start a new chain), open an incident.

---

## JWT secret rotation (dual-kid window)

Production rotates `JWT_SECRET` without invalidating in-flight tokens
by running a **dual-kid window**: the new secret signs new tokens
under a new `kid`, while the previous secret keeps verifying tokens
issued before the rotation. This is implemented by
[`src/utils/auth/jwt-key-rotation.ts`](../src/utils/auth/jwt-key-rotation.ts)
and the `kid`-keyed key set inside `JWTManager`.

### Rollout playbook

Assume current state: `JWT_ACTIVE_KID=kid-3`, `JWT_SECRET=<secret-3>`,
`JWT_PRIOR_KIDS=kid-2:<secret-2>`.

1. **Generate the new secret** (≥ 32 chars, high-entropy):

   ```bash
   openssl rand -base64 48
   ```

2. **Write it to the secret store** (Vault / AWS Secrets Manager) under
   a new path; let ESO sync (default refresh 60s).

3. **Update the env** so the new kid becomes active and the previously
   active kid moves into the prior list:

   ```env
   JWT_ACTIVE_KID=kid-4
   JWT_SECRET=<secret-4>
   JWT_PRIOR_KIDS=kid-3:<secret-3>,kid-2:<secret-2>
   ```

4. **Rolling restart** the API Deployment:

   ```bash
   kubectl rollout restart deployment/noip-platform -n noip-production
   ```

   New tokens are now signed with `kid-4`; in-flight tokens signed
   with `kid-3` or `kid-2` continue to verify.

5. **Wait for the longest token lifetime** to elapse — default refresh
   token TTL is **7 days**. Until then, you cannot drop a kid from
   `JWT_PRIOR_KIDS` without forcing affected users to re-authenticate.

6. **Trim the oldest kid** out of `JWT_PRIOR_KIDS`:

   ```env
   JWT_PRIOR_KIDS=kid-3:<secret-3>
   ```

   Roll the Deployment again. `kid-2` is now retired.

Malformed `JWT_PRIOR_KIDS` entries throw at boot rather than
silently dropping — see the comments at the top of
`jwt-key-rotation.ts`. This is intentional: a typo in a Vault payload
would otherwise cause a silent signing-window outage.

---

## Audit-chain integrity check

The Audit context exposes `verifyChainIntegrity(range)` on its api
barrel ([`src/contexts/audit/api/index.ts`](../src/contexts/audit/api/index.ts)).
It re-computes the hash chain over the requested time range and
returns a `ChainIntegrityReport`.

There is no shipped CLI script — the canonical call is from a Node.js
REPL inside a running pod:

```bash
kubectl exec -it deploy/noip-platform -n noip-production -- node -e "
  const { buildAuditApi } = require('./dist/contexts/audit/api');
  const audit = buildAuditApi(/* injected deps */);
  audit.verifyChainIntegrity({
    from: new Date(Date.now() - 24*3600*1000),
    to:   new Date()
  }).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
"
```

The report includes the first broken link (if any) and the
recomputed-vs-stored hash. Run it on a schedule (Kubernetes CronJob)
nightly and alert on `report.broken === true`.

---

## Scaling

The API Deployment ships with a `HorizontalPodAutoscaler` defined in
[`k8s/deployments/noip-platform-deployment.yaml`](../k8s/deployments/noip-platform-deployment.yaml).
Tune the HPA against the metrics actually exposed (ADR-0023):

| Signal | Metric | Recommended target |
|--------|--------|---------------------|
| CPU | container CPU | 70% utilisation |
| HTTP latency | `noip_http_request_duration_seconds` p95 | < 300 ms |
| AI queue depth | `noip_ai_pending_requests` | < 20 per replica |
| Audit persist failures | `noip_audit_persist_failed_total` rate | 0; scale on errors, not on load |

Scale **MongoDB** vertically (more replicas in the StatefulSet) and
**Redis** vertically (single-shard + replica today; see ADR-0026 for
the future microservices split where Redis-Cluster becomes worth the
operational cost).

Do not scale Discovery / Security scheduler pods above 1 replica
without coordinating leader election — both contexts assume a single
writer for cron-driven snapshots and scans.

---

## Backup and restore (ADR-0014)

### MongoDB

```bash
# Backup (run inside one of the StatefulSet pods)
kubectl exec -it mongodb-0 -n noip-production -- \
  mongodump --uri="$MONGODB_URI" --out=/backup/$(date +%Y-%m-%d)

# Restore
kubectl exec -it mongodb-0 -n noip-production -- \
  mongorestore --uri="$MONGODB_URI" /backup/2026-05-16
```

A nightly CronJob driving `mongodump` to an off-cluster object store
(S3 / GCS) is the recommended pattern; the audit collection MUST be
included and stored on a separate retention class (regulator
requirement varies — 1y / 3y / 7y are typical).

### Redis

Redis is treated as **rebuildable cache** for most keys (permission
cache, rate-limit counters, MFA challenges). The exception is the
**refresh-token family** state — losing it forces all users to
re-authenticate, but does not lose data.

If you need durable Redis snapshots:

```bash
kubectl exec -it redis-0 -n noip-production -- redis-cli BGSAVE
kubectl cp noip-production/redis-0:/data/dump.rdb ./redis-$(date +%Y-%m-%d).rdb
```

Restore by stopping Redis, replacing `/data/dump.rdb`, and starting
again. Schedule `BGSAVE` daily; ship the rdb to the same off-cluster
bucket as the Mongo dumps.

### Restore drills

Run a quarterly drill: restore into a sandbox cluster, hit
`/health/ready`, and run `audit.verifyChainIntegrity()` over the last
30 days. A drill that exits with `report.broken === false` is the
signature on the backup process.

---

## Useful one-liners

```bash
# Pod logs (structured JSON in production):
kubectl logs -l app=noip-platform -n noip-production --tail=200 -f

# Force a graceful re-roll (e.g. after config change):
kubectl rollout restart deployment/noip-platform -n noip-production

# Verify HPA is computing metrics:
kubectl get hpa noip-platform-hpa -n noip-production -o yaml

# Peek at the active metrics registry:
kubectl exec -it deploy/noip-platform -n noip-production -- \
  wget -qO- localhost:3000/metrics | head -50

# Watch readiness flip during a deploy:
watch -n 1 'kubectl get pods -l app=noip-platform -n noip-production'
```

---

## Escalation

- **Sev-1** (data loss / breach suspected): rotate `JWT_SECRET`
  (dual-kid window above), revoke active sessions in Redis
  (`FLUSHDB` on the sessions namespace only), open an incident under
  the process in [`SECURITY.md`](../SECURITY.md).
- **Sev-2** (degraded but serving): consult the failure-mode table
  above; capture metric + log snapshots before any mitigation.
- **Sev-3** (single-pod failure): kubectl-driven restart is fine;
  no human handoff required.
