# PRODUCTION_READINESS.md

**Status:** Mission in progress
**Branch:** `claude/adr-ddd-documentation-uNdZ2`
**Baseline:** 659/659 unit tests across 81 suites green at `db0e2ba`

This document is the shared coordination state for the production-readiness
mission. Agents check off items here once the reviewer agent has confirmed
the change passes the full check suite (build + unit + integration + e2e +
lint + typecheck + benchmarks + ADR compliance + DDD boundaries).

---

## SUMMARY (filled in at exit)

_To be written when the exit condition is met._

---

## 1. What this project is

NetOps Intelligence Platform (NOIP) — a TypeScript/Node.js Express API that
performs Kubernetes infrastructure discovery, security scanning, compliance
reporting, Claude-powered AI analysis, and dashboarding. Persistence is
MongoDB + Redis; AI analysis uses Anthropic Claude with a ChromaDB RAG
backend. Deployed as Kubernetes-native manifests with multi-stage Docker
builds.

The architecture is a modular monolith organised by bounded context under
`src/contexts/<context>/{api,application,domain,infrastructure,http}/`.

---

## 2. Current state

### Bounded contexts implemented

| Context | Status | Location |
|---------|--------|----------|
| **IAM** | Mostly built, NOT yet under `src/contexts/` | `src/services/auth.service.ts`, `src/utils/auth/*`, `src/services/iam/*`, `src/middleware/{auth,require-permission,require-mfa-verified}.middleware.ts` |
| **Discovery** | ✅ Full context | `src/contexts/discovery/` |
| **Security & Compliance** | ✅ Full context | `src/contexts/security/` |
| **AI Analysis** | ✅ Full context | `src/contexts/ai/` |
| **Performance** | ❌ Mock only | `src/services/performance.service.ts` |
| **Dashboard** | ❌ Mock only | `src/services/dashboard.service.ts` |
| **Audit & Observability** | Partial — mid-context, no full barrel | `src/services/audit/*`, `src/middleware/audit.middleware.ts`, `src/models/audit-log.model.ts` |

### Test counts

- Unit: 659 tests / 81 suites green
- Integration: 9 suites failing (need Mongo + Docker + Playwright env or
  stubs)
- Contract: 2 suites added (Chroma + scanner); skip-gated when binaries
  absent
- Benchmarks: 10 added across phases; all in `tests/performance/*.bench.test.ts`

### Known regressions / debt

- Stale Phase 5 worktree `worktree-agent-a08124287b706b357` (last touched
  2026-05-10, agent is dead) — needs cleanup.
- Three legacy service files superseded by contexts but still on disk:
  `src/services/discovery.service.ts` (mock), `src/services/performance.service.ts`
  (placeholder), `src/services/dashboard.service.ts` (placeholder).
- `npm run typecheck` emits ~400 pre-existing errors concentrated in
  `src/models/*.model.ts` (Mongoose typing), `src/services/auth.service.ts`
  (ServiceResponse<T> vs raw T), `src/database/mongodb.ts` (`noUncheckedIndexedAccess`),
  `src/controllers/{compliance,performance}.controller.ts`.
- `npm audit`: 41 vulnerabilities (1 low, 26 moderate, 12 high, 2 critical).

---

## 3. ADR compliance matrix

| # | Title | Status | Code compliant? | Gap |
|---|-------|--------|-----------------|-----|
| 0001 | Record architecture decisions | Accepted | ✅ | — |
| 0002 | TypeScript + Node.js stack | Accepted | ✅ | — |
| 0003 | Express web framework | Accepted | ✅ | — |
| 0004 | MongoDB primary datastore | Accepted | ✅ | — |
| 0005 | Redis cache and sessions | Accepted | ✅ | Shared client wired; namespaces used. |
| 0006 | JWT authentication | Accepted, **Implementation Complete** | ✅ | Redis denylist + family theft + kid rotation; wired at composition root. |
| 0007 | Argon2 password hashing | Accepted | ✅ | Argon2id default + bcrypt-prefix fallback in `PasswordService`. |
| 0008 | RBAC + permissions | Accepted | ✅ | Resolver + cache + invalidation; `requirePermission` middleware. |
| 0009 | MFA (TOTP + backup) | Accepted | ✅ | Service rewritten with Redis state + grace period middleware. |
| 0010 | Layered service architecture | Accepted | 🟡 | Lint rule enforcing `import/no-restricted-paths` is **not yet added**. |
| 0011 | Modular monolith / bounded contexts | Accepted | 🟡 | IAM and Audit are NOT yet under `src/contexts/`. |
| 0012 | Anthropic Claude integration | Accepted | ✅ | Adapter with retry / circuit breaker / cache headers / typed errors. |
| 0013 | RAG / ChromaDB | Accepted | ✅ | Adapter + in-memory fallback + contract harness. |
| 0014 | Kubernetes-native deployment | Accepted | ✅ | `k8s/` manifests present. |
| 0015 | Docker multi-stage builds | Accepted | ✅ | `docker/` Dockerfiles present. |
| 0016 | Rate limiting | Accepted, **Implementation Complete** | ✅ | Per-bucket Redis-backed limiters mounted on `/api/auth/*`; fail modes per ADR. |
| 0017 | Audit logging | Accepted | ✅ | Hash chain + sanitiser + append-only schema. |
| 0018 | Security events as domain events | Accepted | ✅ | EventBus + audit subscribers wired. |
| 0019 | Configuration / feature flags | Accepted | ✅ | `validateConfig` on import; refuses unsafe defaults in production. |
| 0020 | Health checks + graceful shutdown | Accepted | ✅ | Split `/health/{live,ready,startup}` probes + signal handlers. |
| 0021 | Testing strategy | Accepted | 🟡 | Pyramid in place; Testcontainers-driven integration tests not landed. |
| 0022 | ESLint + Prettier | Accepted | 🟡 | Format/lint runs; architectural `import/no-restricted-paths` rules NOT enabled. |
| 0023 | Prometheus observability | Accepted | 🟡 | Metrics emitted as structured log lines today; no `prom-client` registry or `/metrics` endpoint. |
| 0024 | Helmet + CORS security headers | Accepted | 🟡 | Default `helmet()` only — explicit CSP/HSTS/COOP/COEP policy from the ADR is NOT applied. |
| 0025 | Secrets management | Accepted | 🟡 | Documentation only — no ESO manifests, SOPS config, or detect-secrets pre-commit. |
| 0026 | Microservices evolution | Proposed | n/a | Future. |

---

## 4. DDD integrity assessment

Per `docs/architecture/ddd/`:

- ✅ **Strategic design** — subdomains classified core/supporting/generic.
- ✅ **Ubiquitous language** — glossary covers all contexts.
- ✅ **Aggregate invariants enforced** — Discovery, Security, AI aggregates have
  `pendingEvents`, immutability rules, lifecycle gates.
- 🟡 **Bounded context isolation** — Discovery / Security / AI go through
  `api/index.ts` barrels; IAM and Audit do NOT (still in `src/services/`,
  `src/utils/auth/`).
- 🟡 **Domain layer purity** — Discovery/Security/AI domain folders import
  only from `src/shared/` and own files. IAM is mixed (some domain logic
  lives inside service classes).
- 🟡 **Architecture tests** — no `eslint-plugin-import` `no-restricted-paths`
  rules yet enforce the barrels.
- ✅ **Repositories return aggregates** — implemented for Discovery, Security,
  AI; legacy IAM still uses Mongoose models directly.
- ✅ **Domain events** — full registry under DDD-12, in-process bus wired,
  audit subscribers active.

---

## 5. Performance baseline

| Path | p50 | p95 | Bench file |
|------|-----|-----|------------|
| JWT verify | 0.23ms | 0.34ms | `tests/performance/jwt-verify.bench.ts` |
| Audit append | 0.41ms | 0.87ms | `tests/performance/audit-append.bench.ts` |
| Redactor | 33.7ms (10k rows) | 35.5ms | `tests/performance/redactor.bench.test.ts` |
| Prompt composer | 2.18ms | 4.36ms | `tests/performance/prompt-composer.bench.test.ts` |
| Policy engine | 54.9ms (10k records) | 92.7ms | `tests/performance/policy-engine.bench.test.ts` |
| Snapshot hash | 268ms (10k records) | 281ms | `tests/performance/discovery-snapshot.bench.test.ts` |
| Snapshot archive | 73ms (1k records) | 103ms | `tests/performance/snapshot-archive.bench.test.ts` |
| Composite scanner fan-out | 401ms (5 adapters @200ms) | 401ms | `tests/performance/composite-scanner.bench.test.ts` |
| Auth login | 0.56ms | 0.92ms | `tests/performance/auth-login.bench.test.ts` |

Missing benches: SLO computation, dashboard widget data resolver, hash-chain
archive, transparency-log submit, IAM permission resolver.

---

## 6. Task checklist

### 6.1 Blocking bugs / dead state (immediate)
- [ ] Delete stale Phase 5 worktree branch `worktree-agent-a08124287b706b357`
- [ ] Delete superseded legacy service files (`src/services/{discovery,performance,dashboard}.service.ts`) — only after their replacement contexts exist

### 6.2 Bounded context implementation (unfinished from Phase 5)
- [ ] **Performance context** — full `src/contexts/performance/` (probes, load tests, SLOs, Prometheus adapter)
- [ ] **Dashboard context** — full `src/contexts/dashboard/` (Dashboard/Widget/Report aggregates, multi-format renderer, S3 adapter)
- [ ] **Audit hardening** — move `src/services/audit/` and `src/middleware/audit.middleware.ts` into `src/contexts/audit/`; add archive service + transparency-log adapter; complete the `audit.api` barrel
- [ ] **IAM extraction** — move `src/services/auth.service.ts`, `src/utils/auth/*`, `src/services/iam/*`, `src/middleware/{auth,require-permission,require-mfa-verified}.middleware.ts` into `src/contexts/iam/`; create the `iam.api` barrel

### 6.3 ADR-specific implementation gaps
- [ ] **ADR-0023 Prometheus** — `prom-client` registry + `/metrics` endpoint; replace log-line metric emissions with real counters/histograms across all contexts
- [ ] **ADR-0024 Helmet/CORS** — explicit CSP/HSTS/COOP/COEP policy per the ADR; CORS allow-list driven by config; cookie policy
- [ ] **ADR-0025 Secrets management** — `k8s/secrets/external-secrets/` manifests, `.sops.yaml` for dev encryption, `detect-secrets` pre-commit hook, `JWT_SECRET` dual-key window helper
- [ ] **ADR-0010 / ADR-0022 boundary enforcement** — `eslint-plugin-import` `no-restricted-paths` zones blocking cross-context model imports; one test per zone proving it triggers
- [ ] **ADR-0021 integration tests** — Testcontainers harness for Mongo + Redis; re-enable the currently-failing integration suites

### 6.4 Pre-existing repo debt
- [ ] `npm run typecheck` exits 0 — sweep the ~400 pre-existing errors (Mongoose typing, ServiceResponse<T>, noUncheckedIndexedAccess, unknown-in-catch)
- [ ] `npm run lint:check` zero warnings (currently ~110 `no-explicit-any` warnings)
- [ ] `npm audit` — patch high/critical vulnerabilities or document why deferred
- [ ] `npm run build` exits 0 (depends on typecheck cleanup)

### 6.5 Observability gaps
- [ ] Metrics: `noip_http_requests_total`, `noip_http_request_duration_seconds`, `noip_auth_*`, `noip_ai_*`, `noip_security_findings_total`
- [ ] Structured JSON logs with mandatory fields (`requestId`, `userId?`, `event`)
- [ ] OpenTelemetry SDK + OTLP exporter (`http`, `mongoose`, `redis` instrumentations)
- [ ] Alertmanager rules in `k8s/monitoring/`

### 6.6 Security hygiene
- [ ] Input validation at HTTP boundaries (`express-validator` schemas on every route)
- [ ] `authz` middleware mounted on every protected operation
- [ ] Secret-scanner pre-commit (`detect-secrets`)
- [ ] No `console.log` / debug prints / `TODO` / `FIXME` in shipped paths
- [ ] CORS allow-list enforced
- [ ] HSTS / CSP / COOP / COEP headers shipped

### 6.7 Tests + benchmarks
- [ ] Integration tests pass (currently 9 suites failing on module load due to legacy refactor remnants)
- [ ] E2E test for the platform happy path (login → run scan → see findings → request AI analysis → see insight)
- [ ] Contract tests skip-gate cleanly
- [ ] Add missing benches (SLO computer, widget resolver, hash-chain archive, transparency log, permission resolver)
- [ ] Bench-regression CI check (fail if any p95 increases > 5% vs baseline)

### 6.8 Documentation
- [ ] `README.md` covers: what it is, install, run, test, deploy
- [ ] `CONTRIBUTING.md` reflects current branch / DI patterns
- [ ] All accepted ADRs have an `Implementation:` line once code is in place
- [ ] Inline docs on every public-API export

### 6.9 Polish
- [ ] `prettier --check` zero changes
- [ ] Lockfile committed and `npm ci` deterministic
- [ ] CI config (`.github/workflows/*`) runs build + lint + typecheck + tests + benchmarks

---

## 7. Coordination protocol

- **Agents** check off items in §6 only after the reviewer agent confirms the
  full check suite passes.
- Each agent writes its commit SHAs into a "Recently merged" section below.
- Reviewer agent gates `npm run typecheck`, `npm run lint:check`,
  `npx jest --config=jest.config.cjs tests/unit`, and any context-specific
  benches.
- Each ADR gains an `- **Implementation:** Complete (date) — <short note>`
  line as it lands, identical pattern to ADR-0006 / ADR-0016 today.
- Push after every merge.

---

## 8. Recently merged

- `db0e2ba` AuthService → composition root + JWTManager Redis wiring + per-bucket auth limiters + legacy `RateLimitMiddleware` retirement (ADR-0006, ADR-0016 implementation complete)
- `e6ddf3f` ChromaDB contract-test harness (ADR-0013 hardening)
- `0f00d0a` Real CLI scanner toggle paths (ADR-0007 — security side)
- `16d2933` Snapshot archiving for Discovery context (Phase 2 deferred)

---

## 9. NEEDS HUMAN DECISION

_(nothing yet)_
