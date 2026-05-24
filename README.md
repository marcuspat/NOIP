# NetOps Intelligence Platform (NOIP)

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.1-black.svg)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-6+-green.svg)](https://www.mongodb.com/)
[![Redis](https://img.shields.io/badge/Redis-7+-red.svg)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-blue.svg)](https://www.docker.com/)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-compatible-blue.svg)](https://kubernetes.io/)
[![Tests](https://img.shields.io/badge/Tests-312%20passing-brightgreen.svg)](#testing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Enterprise-Grade Infrastructure Intelligence Platform**

*Automated Discovery • Security Scanning • AI Analysis • Real-Time Dashboards*

[**Quick Start**](#quick-start) • [**Architecture**](#architecture) • [**API Reference**](#api-reference) • [**Documentation**](#documentation) • [**Contributing**](#contributing)

</div>

---

## What Is NOIP?

NOIP is a **TypeScript/Node.js backend platform** that gives operations, security, and compliance teams a single API surface for:

- **Kubernetes cluster discovery** — scan namespaces, pods, nodes, and network topology; detect configuration drift between scans
- **Security analysis** — vulnerability scoring, secret detection, compliance checking, security recommendations
- **AI-powered insights** — send infrastructure context to an LLM (Anthropic Claude-compatible port) for natural-language analysis
- **Performance load testing** — define scenarios, run simulated load, collect p50/p95/p99 metrics, identify bottlenecks
- **Live dashboards** — assemble dashboard widgets from live service data; export JSON
- **Compliance reporting** — map findings to SOC 2, ISO 27001, GDPR, PCI-DSS, and HIPAA control frameworks

Everything is exposed through a versioned REST API at `/api/v1/*`, protected by JWT authentication with multi-factor authentication (TOTP, SMS, email) and role-based access control.

---

## Quick Start

### Prerequisites

| Dependency | Minimum Version |
|---|---|
| Node.js | 22.x |
| npm | 10.x |
| MongoDB | 6.x |
| Redis | 7.x (optional — platform degrades gracefully without it) |

### Install and run

```bash
git clone https://github.com/marcuspat/noip.git
cd noip
npm install
```

Copy the environment template and fill in your values:

```bash
cp .env.example .env
```

Start the platform:

```bash
# Development (ts-node, hot-friendly)
npm run dev

# Production (compile first, then run)
npm run build
npm start
```

The API starts on port **3000** by default. Confirm with:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "environment": "development",
  "timestamp": "2025-05-24T00:00:00.000Z",
  "services": {
    "database": "connected",
    "cache": "connected"
  }
}
```

---

## Environment Variables

```bash
# ── Required ──────────────────────────────────────────────
NODE_ENV=production           # development | staging | production
PORT=3000

# Database
MONGODB_URI=mongodb://localhost:27017/noip
REDIS_URL=redis://localhost:6379

# JWT (generate with: openssl rand -base64 64)
JWT_SECRET=<64-char-random-string>
JWT_REFRESH_SECRET=<64-char-random-string>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ── Optional – AI analysis ─────────────────────────────────
ANTHROPIC_API_KEY=<your-anthropic-api-key>

# ── Optional – Notifications ───────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=alerts@example.com
SMTP_PASS=<smtp-password>

# ── Optional – Kubernetes discovery ───────────────────────
KUBECONFIG=$HOME/.kube/config

# ── Optional – Tuning ─────────────────────────────────────
LOG_LEVEL=info                # error | warn | info | debug
RATE_LIMIT_WINDOW_MS=900000   # 15 minutes
RATE_LIMIT_MAX=100            # requests per window
```

---

## Architecture

```
noip/
├── src/
│   ├── app.ts                      # Express app factory + server bootstrap
│   ├── config/                     # Typed configuration with env validation
│   ├── controllers/                # HTTP layer (auth, compliance)
│   ├── middleware/                 # Auth, correlation IDs, request logging
│   ├── models/                     # Mongoose schemas (13 models)
│   │   ├── user.model.ts           # Users, sessions, MFA, RBAC
│   │   ├── cluster.model.ts        # Discovered clusters
│   │   ├── snapshot.model.ts       # Immutable cluster-state snapshots
│   │   ├── drift-report.model.ts   # Detected drift between snapshots
│   │   ├── finding.model.ts        # Deduplicated security findings
│   │   └── compliance-*.model.ts   # Frameworks, controls, evidence, assessments
│   ├── routes/                     # Express routers
│   │   ├── auth.routes.ts
│   │   ├── compliance.routes.ts
│   │   └── performance.routes.ts
│   ├── services/                   # Business logic
│   │   ├── auth.service.ts         # Auth lifecycle, MFA, token rotation
│   │   ├── discovery.service.ts    # K8s scan + drift detection + persistence
│   │   ├── finding.service.ts      # SHA-256 dedup, auto-resolve, re-open
│   │   ├── security.service.ts     # Vulnerability + secret scanning
│   │   ├── compliance.service.ts   # Framework evaluation and reports
│   │   ├── performance.service.ts  # Load test execution and metrics
│   │   ├── dashboard.service.ts    # Widget assembly and export
│   │   ├── ai/                     # LLM ports (swappable mock / real client)
│   │   └── discovery/
│   │       └── fingerprint.ts      # Canonical SHA-256 drift fingerprinting
│   ├── types/                      # Shared TypeScript interfaces
│   └── utils/
│       ├── auth/                   # JWT manager, password service, device fingerprint
│       ├── logger.ts               # Winston structured JSON logger
│       ├── redact.ts               # Log redaction (keys + PEM/JWT/AWS patterns)
│       ├── redis-client.ts         # Lazy-connect Redis factory
│       └── event-bus.ts            # In-process pub/sub with correlation metadata
├── tests/
│   ├── auth/                       # Unit + integration auth tests
│   ├── integration/                # Discovery persistence, finding service
│   ├── security/                   # Security posture tests
│   ├── performance/                # Load test suite
│   ├── kubernetes/                 # Manifest validation tests
│   └── container/                  # Docker image tests (skipped without daemon)
├── k8s/                            # Kubernetes manifests
│   ├── namespace/
│   ├── configmaps/
│   ├── secrets/                    # Keys-only template (values injected at deploy)
│   ├── deployments/                # Deployment + HPA + PodDisruptionBudget
│   ├── services/
│   ├── database/                   # MongoDB + Redis StatefulSets
│   ├── monitoring/                 # Prometheus + Grafana
│   ├── ingress/                    # TLS, rate-limit annotations
│   └── security/                   # NetworkPolicy, ResourceQuota, PSP, RBAC
├── docker/                         # Dockerfile, Dockerfile.dev, Dockerfile.test
├── docker-compose.yml
├── docs/
│   ├── adr/                        # 20 Architecture Decision Records
│   └── ddd/                        # Domain-Driven Design documentation
└── package.json
```

### Key Design Decisions

The platform's architecture is documented in 20 Architecture Decision Records under `docs/adr/`. Notable decisions:

| ADR | Decision |
|-----|----------|
| ADR-0001 | TypeScript 5.x strict mode throughout |
| ADR-0002 | Express 5 with `/api/v1` versioning and legacy `/api` with deprecation headers |
| ADR-0003 | MongoDB (Mongoose 8) as primary store; Redis for caching and rate limiting |
| ADR-0004 | JWT access tokens (15 min) + refresh token rotation with per-issuance jti replay detection |
| ADR-0005 | Argon2id password hashing |
| ADR-0006 | Multi-factor authentication: TOTP, SMS, email, backup codes |
| ADR-0010 | Domain-Driven Design bounded contexts |
| ADR-0015 | Immutable snapshots (pre-save hook blocks mutations) |
| ADR-0016 | SHA-256 fingerprint deduplication for findings |
| ADR-0019 | AI via hexagonal port (swappable mock/real client) |

Full DDD context map, ubiquitous language, and aggregate documentation: `docs/ddd/`.

---

## API Reference

All routes are prefixed `/api/v1`. The legacy prefix `/api` also works and returns `Deprecation`/`Sunset` headers.

### Authentication — `/api/v1/auth`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register new user |
| `POST` | `/login` | Login (returns access + refresh tokens) |
| `POST` | `/refresh` | Rotate refresh token |
| `POST` | `/logout` | Invalidate session |
| `GET` | `/verify-email/:token` | Verify email address |
| `POST` | `/forgot-password` | Send reset email |
| `POST` | `/reset-password` | Reset password with token |
| `POST` | `/mfa/enable` | Enable TOTP/SMS/email MFA |
| `POST` | `/mfa/verify` | Verify MFA challenge during login |
| `POST` | `/mfa/disable` | Disable MFA |
| `GET` | `/mfa/backup-codes` | Retrieve backup codes |

**Example — Login:**

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"P@ssw0rd!23"}'
```

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "user": { "id": "...", "email": "admin@example.com", "role": "admin" }
  }
}
```

### Discovery — `/api/v1/discovery`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cluster` | Cluster metadata |
| `GET` | `/resources` | All discovered resources |
| `GET` | `/namespaces` | Namespace list |
| `GET` | `/nodes` | Node inventory |
| `POST` | `/scan` | Trigger a full cluster scan (persists snapshot + drift report) |
| `GET` | `/scan` | Trigger scan via GET |
| `GET` | `/scan/pods` | Pod scan results |
| `GET` | `/scan/network` | Network topology scan |

Scans persist an immutable `Snapshot`, compare against the previous snapshot, and write a `DriftReport` if any resources changed. Findings are fingerprinted (SHA-256) and deduplicated — recurrences update `lastSeenAt`; findings absent from the latest scan are auto-resolved.

### Security — `/api/v1/security`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/score` | Overall security score (0–100) |
| `GET` | `/recommendations` | Prioritized security recommendations |
| `POST` | `/scan` | Full security scan |
| `GET` | `/scan/pods` | Pod-level security analysis |
| `GET` | `/scan/network` | Network-level security analysis |

### AI Analysis — `/api/v1/ai`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/analyze/infrastructure` | Comprehensive infrastructure analysis |
| `POST` | `/analyze/security` | Security-focused LLM analysis |
| `POST` | `/analyze/compliance` | Compliance gap analysis |

The AI service uses a hexagonal port pattern. In development and tests a mock client is used. Set `ANTHROPIC_API_KEY` to wire the real Claude API.

### Dashboard — `/api/v1/dashboard`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List dashboard widgets |
| `GET` | `/:id` | Get specific widget |
| `POST` | `/` | Create widget |
| `GET` | `/widget/:id/data` | Live data for a widget |

### Performance — `/api/v1/performance`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/test` | Run a load test |
| `GET` | `/test/:id` | Get test result by ID |
| `POST` | `/start-monitoring` | Start continuous monitoring |
| `POST` | `/stop-monitoring` | Stop monitoring |
| `GET` | `/metrics` | Current system metrics |
| `GET` | `/history` | Test history |
| `GET` | `/summary` | Performance summary |
| `GET` | `/configs` | Standard test configurations |
| `GET` | `/health` | Service health |

### Compliance — `/api/v1/compliance`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/report` | Generate compliance report |
| `GET` | `/frameworks` | List supported frameworks |
| `GET` | `/frameworks/:id` | Framework detail |
| `GET` | `/frameworks/:id/controls` | Framework controls |
| `GET` | `/controls` | All controls |
| `POST` | `/evidence` | Submit evidence |
| `GET` | `/assessments` | List assessments |
| `GET` | `/assessments/:id` | Assessment detail |
| `GET` | `/dashboard` | Compliance dashboard summary |
| `GET` | `/gaps` | Identified control gaps |

Supported frameworks: **SOC 2**, **ISO 27001**, **GDPR**, **PCI-DSS**, **HIPAA**.

---

## Security Model

### Authentication

- Passwords hashed with **Argon2id** (memory-hard, side-channel resistant)
- Access tokens: **JWT HS256**, 15-minute expiry, per-issuance `jti` for replay detection
- Refresh tokens: 7-day expiry with rotation on each use
- Session management: Redis-backed cache with MongoDB persistence fallback

### Multi-Factor Authentication

Enable MFA after login:

```bash
curl -X POST http://localhost:3000/api/v1/auth/mfa/enable \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{"method":"totp"}'
```

Supported methods: `totp` (authenticator app), `sms`, `email`, plus 10 one-time backup codes.

### Rate Limiting

- **Global limiter**: 100 requests / 15 min per IP (Redis-backed sliding window)
- **Auth limiter**: 5 requests / 15 min on `/api/v1/auth/*` endpoints
- Redis unavailable → in-memory fallback (fail-open, no outage)

### RBAC

Roles and permissions are seeded on first start. The permission evaluator uses a pure-function allow-list of condition keys — no DSL evaluation, no `eval()`.

---

## Testing

```bash
# Full test suite (unit + integration)
npm test

# Integration tests only
npm run test:integration

# Unit tests only
npm run test:unit

# With coverage report
npm run test:coverage

# Type checking only (fast)
npm run typecheck
```

Current results: **312 passing**, 21 skipped (Docker container tests — skipped automatically when no Docker daemon is available), 0 failing.

Tests use **mongodb-memory-server** for full isolation — no external database required.

---

## Docker

```bash
# Development
docker-compose up

# Production
docker-compose -f docker-compose.prod.yml up

# Build image manually
docker build -f docker/Dockerfile -t noip/platform:latest .
```

The production image:
- Multi-stage build (builder → runtime)
- Non-root user (`nodejs`)
- `HEALTHCHECK` pointing at `/health`
- Minimal layer count

---

## Kubernetes

Complete manifests are in `k8s/`. Deploy order:

```bash
kubectl apply -f k8s/namespace/
kubectl apply -f k8s/security/        # NetworkPolicy, ResourceQuota, PSP, RBAC
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/secrets/         # Populate values before applying
kubectl apply -f k8s/database/        # MongoDB + Redis StatefulSets
kubectl apply -f k8s/services/
kubectl apply -f k8s/deployments/     # Deployment + HPA + PodDisruptionBudget
kubectl apply -f k8s/monitoring/      # Prometheus + Grafana
kubectl apply -f k8s/ingress/         # TLS + rate-limit annotations
```

> **Secrets**: `k8s/secrets/secrets.yaml` is a keys-only template with empty values. Populate via external-secrets, sealed-secrets, or your secrets manager before applying.

The deployment includes:
- **HorizontalPodAutoscaler** — scales 2–10 replicas based on CPU/memory
- **PodDisruptionBudget** — minimum 1 replica available during node drains
- **NetworkPolicy** — restricts ingress/egress to declared selectors
- **SecurityContext** — `runAsNonRoot: true`, all capabilities dropped

---

## Development Workflow

```bash
# Install dependencies
npm install

# Type-check (no emit)
npm run typecheck

# Lint (check only)
npm run lint:check

# Lint + auto-fix
npm run lint

# Format with Prettier
npm run format

# Run tests
npm test

# Full build (lint + typecheck + compile)
npm run build
```

### Project conventions

- **Strict TypeScript** — `"strict": true`, no implicit any
- **ESLint 9 flat config** with bounded-context import rules
- **Prettier** enforced via lint-staged pre-commit hook
- **Winston** structured JSON logging; sensitive values redacted automatically
- **Correlation IDs** — `X-Correlation-ID` propagated via `AsyncLocalStorage` through every request

---

## Documentation

| Location | Contents |
|----------|----------|
| `docs/adr/` | 20 Architecture Decision Records (ADR-0001 – ADR-0020) |
| `docs/ddd/` | DDD context map, ubiquitous language, aggregate definitions, domain events |
| `USE_CASE_GUIDE.md` | Concrete use cases with API examples for each team persona |
| `VALIDATION_REPORT.md` | Full command inputs and outputs from CI validation run |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes — the pre-commit hook runs lint-staged
4. Run tests: `npm test`
5. Push and open a Pull Request

Please follow the existing bounded-context structure when adding new services. New architectural decisions should be documented as ADRs in `docs/adr/`.

---

## License

MIT License — see [LICENSE](LICENSE).

---

<div align="center">

**NetOps Intelligence Platform**
*Enterprise-Grade Infrastructure Intelligence & Security*

[Use Case Guide](USE_CASE_GUIDE.md) • [Validation Report](VALIDATION_REPORT.md) • [ADRs](docs/adr/) • [DDD Docs](docs/ddd/)

</div>
