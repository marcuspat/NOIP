# NetOps Intelligence Platform (NOIP)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

A TypeScript/Node.js platform that continuously discovers Kubernetes
infrastructure, runs security and compliance scans, augments findings with
Claude-based AI analysis, and serves dashboards and reports over a REST API.

The architecture is a **modular monolith** organised by bounded context,
governed by Architecture Decision Records (ADRs) under
[`docs/architecture/adr/`](docs/architecture/adr/) and Domain-Driven Design
artefacts under [`docs/architecture/ddd/`](docs/architecture/ddd/). Mission
state lives in [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

---

## Architecture at a glance

The platform is composed of seven bounded contexts. Detailed per-context
docs are in [`docs/architecture/ddd/`](docs/architecture/ddd/); cross-cutting
decisions are recorded in [`docs/architecture/adr/`](docs/architecture/adr/).

| Bounded context | Subdomain type | One-liner | Source |
|-----------------|----------------|-----------|--------|
| Identity & Access Management (IAM) | Generic | JWT auth, RBAC permission resolver, MFA (TOTP + backup), session and refresh-token state. | `src/services/auth.service.ts`, `src/utils/auth/`, `src/services/iam/`, `src/middleware/{auth,require-permission,require-mfa-verified}.middleware.ts` |
| Infrastructure Discovery | Core | Continuous Kubernetes cluster snapshots; drift detection; archive of historical snapshots. | `src/contexts/discovery/` |
| Security & Compliance | Core | Vulnerability, secret, and config scanning; policy engine; compliance framework coverage. | `src/contexts/security/` |
| AI Analysis | Core | Anthropic Claude adapter with retry/circuit breaker; RAG via ChromaDB; prompt composer; cost guard. | `src/contexts/ai/` |
| Performance | Supporting | SLO computation, probes, load-test orchestration, Prometheus metric adapter. | `src/contexts/performance/` |
| Dashboard & Reporting | Supporting | Dashboard / Widget / Report aggregates; multi-format renderer; widget data resolver. | `src/contexts/dashboard/` |
| Audit & Observability | Generic | Tamper-evident hash-chained audit log, security-event store, transparency log, structured logs, Prometheus registry. | `src/contexts/audit/`, `src/services/audit/`, `src/observability/` |

Read [`docs/architecture/ddd/01-strategic-design.md`](docs/architecture/ddd/01-strategic-design.md)
first for the platform narrative, then
[`docs/architecture/ddd/04-context-map.md`](docs/architecture/ddd/04-context-map.md)
for cross-context integration.

---

## Stack

- **Language / runtime:** TypeScript 5.9, Node.js 18+ (ADR-0002)
- **Web framework:** Express 5 (ADR-0003)
- **Primary datastore:** MongoDB 6+ via Mongoose (ADR-0004)
- **Cache, sessions, rate-limit counters:** Redis 6+ via ioredis (ADR-0005)
- **Auth:** JWT with `kid` rotation (ADR-0006), Argon2id (ADR-0007), RBAC
  (ADR-0008), MFA TOTP + backup codes (ADR-0009)
- **AI:** Anthropic Claude SDK (ADR-0012), ChromaDB RAG (ADR-0013)
- **Deployment:** Kubernetes-native manifests (ADR-0014), multi-stage Docker
  (ADR-0015)
- **Observability:** `prom-client` registry + `/metrics` endpoint (ADR-0023),
  Winston structured logs, `/health/{live,ready,startup}` probes (ADR-0020)
- **Security headers:** Helmet with explicit CSP/HSTS/COOP/COEP + CORS
  allow-list (ADR-0024)
- **Secrets:** External Secrets Operator + SOPS (ADR-0025)

---

## Install

### Prerequisites

- Node.js **18+** (LTS recommended)
- MongoDB **6+** running locally or reachable via `MONGODB_URI`
- Redis **6+** running locally or reachable via `REDIS_HOST`/`REDIS_PORT`
- (Optional) Docker + Docker Compose to spin up Mongo and Redis locally

### Clone and install dependencies

```bash
git clone https://github.com/marcuspat/NOIP.git
cd NOIP
npm ci
npm run prepare    # installs husky + repo git hooks (detect-secrets)
cp .env.example .env   # if present; otherwise see "Run" below
```

### Run datastores locally with Docker

```bash
docker compose -f docker/docker-compose.yml up -d mongodb redis
```

The full local stack (`docker compose up` with no args) also starts an API
container, Prometheus, and Grafana. See
[`docs/INSTALL.md`](docs/INSTALL.md) for environment-by-environment install
paths (dev, CI, production).

---

## Run

```bash
npm run dev      # ts-node, watches src/app.ts
npm start        # runs dist/app.js (requires npm run build first)
npm run build    # tsc → dist/
```

`npm run dev` and `npm start` both run the composition root in
[`src/app.ts`](src/app.ts), which wires:

1. The in-process `EventBus` and audit subscribers (ADR-0018).
2. The shared Redis client (ADR-0005) — used for the JWT denylist, refresh
   token families, permission cache, MFA challenges, rate-limit counters,
   and sessions.
3. The IAM, Discovery, Security, AI, Dashboard, and Performance contexts
   through their `api/index.ts` barrels.
4. HTTP routes, `/metrics`, and `/health/{live,ready,startup}` probes.

### Environment variables (essentials)

Full list is enumerated in [`src/config/index.ts`](src/config/index.ts) and
validated at import time by [`src/config/validation.ts`](src/config/validation.ts).
Deeper documentation is planned in `docs/CONFIGURATION.md`; the most
load-bearing variables are:

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `development` | Switches strict config validation, log format, dev shortcuts. |
| `PORT` | `3000` | HTTP listen port. |
| `MONGODB_URI` | `mongodb://localhost:27017/noip` | Primary datastore (ADR-0004). |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Shared Redis client (ADR-0005). |
| `JWT_SECRET` | placeholder (rejected in prod) | Active JWT signing secret (ADR-0006). |
| `JWT_PRIOR_KIDS` | unset | Dual-kid rotation window: `kid1:secret1,kid2:secret2` (`src/utils/auth/jwt-key-rotation.ts`). |
| `AI_API_KEY` | empty | Anthropic Claude API key (ADR-0012). |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated CORS allow-list (ADR-0024). |
| `ENABLE_HSTS` | `true` | HSTS header toggle; force `true` in prod (ADR-0024). |
| `LOG_LEVEL` | `info` | Winston level. |

When `NODE_ENV=production`, `validateConfig` refuses placeholder secrets,
short JWT keys, and unsafe CORS combinations; the process throws before
serving traffic. In non-production the failures degrade to warnings.

---

## Test

NOIP uses Jest for unit + integration suites and Playwright for e2e
(ADR-0021). The default `npm test` runs the unit suite only; contract and
benchmark suites are opt-in via dedicated configs.

| Command | Scope | State |
|---------|-------|-------|
| `npm test` | Unit suite under `src/**` and `tests/unit/**` | **1025/1025 across 113 suites green** |
| `npm run test:contract` | `tests/contract/ai/**` — Claude / Chroma wire tests. Skip-gated on `CHROMA_URL`. | Skip-clean without env. |
| `npm run test:contract:security` | `tests/contract/security/**` — Trivy, kube-bench, kube-linter, gitleaks. Skip-gated on binary availability. | Skip-clean without binaries. |
| `npx jest --testPathPatterns=tests/performance` | Benchmarks under `tests/performance/*.bench.test.ts`. Opt-in (jest skips them by default). | All green; baseline in `PRODUCTION_READINESS.md` §5. |
| `npm run test:integration` | `tests/integration/**` and `tests/auth/**` — require Mongo + Redis. | **Currently failing** (legacy refactor remnants; tracked in `PRODUCTION_READINESS.md` §6.7). |
| `npm run test:e2e` | Playwright | Tracked under ADR-0021. |

Full per-layer guidance, fixtures, and skip-gate semantics are in
[`docs/TESTING.md`](docs/TESTING.md).

### Build gates

```bash
npm run lint:check   # eslint (0 errors expected)
npm run typecheck    # tsc --noEmit (0 errors expected)
npm run build        # tsc emit; exits 0
```

`npm run pretest` and `npm run prebuild` chain these gates automatically.

---

## Deploy

### Single-host (Docker Compose)

```bash
docker compose -f docker/docker-compose.prod.yml up -d
```

The prod compose file pins images, mounts production configmaps, and runs
the API container, MongoDB, Redis, Prometheus, and Grafana. Configure via
the env vars listed above (or a `.env` next to the compose file).

### Kubernetes

```bash
kubectl apply -f k8s/namespace/
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/secrets/             # placeholders; use ESO in prod
kubectl apply -f k8s/database/            # MongoDB StatefulSet + Redis
kubectl apply -f k8s/services/
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/ingress/
kubectl apply -f k8s/monitoring/
```

Production deployments **must not** apply `k8s/secrets/secrets.yaml`
directly; use the External Secrets Operator manifests under
`k8s/secrets/external-secrets/` (ADR-0025). The
[`scripts/deploy.sh`](scripts/deploy.sh) wrapper orders these steps and
waits on readiness for each layer.

The day-2 playbook — boot order, graceful shutdown, common failure modes,
JWT rotation, audit-chain integrity checks, scaling, and backup/restore —
is in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Security model

The security posture is defined by these ADRs (status as of branch
`claude/adr-ddd-documentation-uNdZ2`):

| ADR | Topic | Implementation |
|-----|-------|----------------|
| [0006](docs/architecture/adr/0006-jwt-authentication.md) | JWT auth + Redis denylist + refresh-family theft detection + `kid` rotation | Complete |
| [0007](docs/architecture/adr/0007-argon2-password-hashing.md) | Argon2id password hashing with bcrypt-prefix fallback | Complete |
| [0008](docs/architecture/adr/0008-rbac-authorization-model.md) | RBAC permission resolver + Redis cache + `requirePermission` middleware | Complete |
| [0009](docs/architecture/adr/0009-mfa-totp-strategy.md) | MFA (TOTP + backup codes) with Redis-backed challenges and grace period | Complete |
| [0016](docs/architecture/adr/0016-rate-limiting-strategy.md) | Per-bucket Redis-backed rate limiters on `/api/auth/*` | Complete |
| [0017](docs/architecture/adr/0017-audit-logging-strategy.md) | Hash-chained append-only audit log with sanitiser | Complete |
| [0024](docs/architecture/adr/0024-helmet-cors-security-headers.md) | Explicit Helmet CSP/HSTS/COOP/COEP + CORS allow-list | Complete |
| [0025](docs/architecture/adr/0025-secrets-management.md) | External Secrets Operator + SOPS + `detect-secrets` pre-commit + JWT dual-kid helper | Complete |

Report vulnerabilities per [`SECURITY.md`](SECURITY.md) — do **not** open
public GitHub issues for security bugs.

---

## Observability

- **Metrics:** Prometheus exposition at `GET /metrics` (ADR-0023). The
  registry lives in [`src/observability/registry.ts`](src/observability/registry.ts);
  typed counters and histograms are defined in
  [`src/observability/metrics.ts`](src/observability/metrics.ts) and emitted
  by the Kubernetes adapter, Anthropic adapter, rate-limit middleware,
  security service, `requirePermission` middleware, auth service, MFA
  service, and audit subscribers. Node default metrics (event loop, GC,
  RSS) are collected at boot via `collectNodeDefaultMetrics()`.
- **Health probes (ADR-0020):**
  - `GET /health/live` — process responsiveness; 503 only when the pod
    should be killed.
  - `GET /health/ready` — all required dependencies reachable AND startup
    complete; 503 stops Kubernetes routing traffic.
  - `GET /health/startup` — bootstrap finished (config validated,
    subscribers installed, Redis connected).
  - `GET /health` — composite human payload.
- **Logs:** Winston structured logs via `src/utils/logger.ts`. JSON output
  in production; pretty output in development.
- **Graceful shutdown:** SIGTERM handlers in `src/app.ts` mark
  `ready=false`, stop scheduled scanners, drain HTTP connections,
  disconnect Mongo and Redis, then exit 0. Hard-timeout via
  `SHUTDOWN_HARD_TIMEOUT_MS` (default 30 s).

---

## Contributing

Contribution workflow, branch naming, commit-message format, and the
ADR-driven decision process are documented in
[`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

- Branch from `claude/adr-ddd-documentation-uNdZ2` (mission branch) or
  `main`. Topic branches use `feat/<short-name>`, `fix/<short-name>`,
  `docs/<short-name>`, `chore/<short-name>`.
- Material design changes land an ADR under
  `docs/architecture/adr/` first, following the
  [`template.md`](docs/architecture/adr/template.md) shape (MADR 3.0 lite).
- All PRs must keep `npm run lint:check`, `npm run typecheck`,
  `npm run build`, and `npm test` exiting 0. Coverage threshold is 80%
  on the unit suite.
- Pre-commit hooks run `detect-secrets` against staged files (ADR-0025);
  do not bypass with `--no-verify`.

---

## License

MIT — see [`LICENSE`](LICENSE).
