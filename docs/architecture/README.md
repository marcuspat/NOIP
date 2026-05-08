# NOIP Architecture Overview

This directory is the entry point for NOIP's architectural documentation. It links the
two complementary views of the system:

- **[Architecture Decision Records (ADR)](../adr/README.md)** — *why* the system is
  shaped the way it is. One file per significant decision, immutable once accepted.
- **[Domain-Driven Design (DDD)](../ddd/README.md)** — *what* the domain looks like.
  Strategic context map, ubiquitous language, and per-context tactical models.

Read the ADR index for technology and structural choices, and the DDD index for the
domain model. The two cross-reference each other where decisions are domain-driven.

---

## 1. What NOIP is

**NOIP (NetOps Intelligence Platform)** is an enterprise infrastructure-intelligence
and security platform. It continuously discovers cloud and Kubernetes resources,
scans them for secrets/vulnerabilities/drift, validates them against compliance
frameworks (SOC2, ISO27001, GDPR, HIPAA, PCI-DSS), and turns the result into
AI-assisted analysis and dashboards for operators and executives.

The user-facing capabilities are:

1. Automated infrastructure discovery (Kubernetes-first, multi-cloud-ready)
2. Security scanning (secrets, vulnerabilities, file-integrity)
3. AI-assisted analysis powered by Anthropic Claude with a learning layer
   (AgentDB vector store + ReasoningBank experience log)
4. Configuration drift detection
5. Compliance reporting and evidence collection
6. Dashboards, reports and exports
7. Performance & load-testing tooling for the platform itself

## 2. System shape (modular monolith)

NOIP today is a single TypeScript/Express service backed by MongoDB and Redis. It is
organised internally as a **modular monolith**: each bounded context lives in its own
slice (model + service + controller + routes) and depends on neighbours only through
explicit service interfaces. This is captured in
[ADR-0012: Modular monolith with explicit bounded contexts](../adr/0012-bounded-context-modular-monolith.md).

```
                 ┌─────────────────────────────────────────────┐
                 │                  HTTP / API                  │
                 │   Express 5  ·  Helmet  ·  CORS  ·  Morgan   │
                 └─────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────┼─────────────────────────┐
            │                          │                          │
            ▼                          ▼                          ▼
   ┌────────────────┐         ┌──────────────────┐      ┌──────────────────┐
   │ Identity & A.  │         │  Discovery       │      │  Compliance      │
   │ /auth          │◀───────▶│  /api/discovery  │◀────▶│  /api/compliance │
   └────────────────┘         └──────────────────┘      └──────────────────┘
            │                          │                          │
            ▼                          ▼                          ▼
   ┌────────────────┐         ┌──────────────────┐      ┌──────────────────┐
   │ Security Ops   │         │ AI Intelligence  │      │  Performance     │
   │ /api/security  │◀───────▶│  /api/ai         │      │  /api/perf       │
   └────────────────┘         └──────────────────┘      └──────────────────┘
                          ▲                          ▲
                          │                          │
                  ┌───────────────┐         ┌────────────────┐
                  │ Audit & Log   │         │ Dashboard /    │
                  │ middleware    │         │ Reporting      │
                  └───────────────┘         └────────────────┘
                          │                          │
                          ▼                          ▼
              ┌────────────────────────────────────────────────┐
              │  MongoDB (documents)        Redis (cache, RL)   │
              └────────────────────────────────────────────────┘
                                       │
                                       ▼
                       External: Anthropic Claude API,
                       Kubernetes API, SMTP, Prometheus
```

## 3. Bounded contexts

The eight bounded contexts and their canonical sources:

| Context | Source | Doc |
|---|---|---|
| Identity & Access | `src/models/{user,role,permission,session}` · `src/services/auth.service.ts` · `src/utils/auth/*` | [identity-and-access](../ddd/contexts/identity-and-access.md) |
| Infrastructure Discovery | `src/services/discovery.service.ts` · `src/types/index.ts` (Cluster, KubernetesResource) | [infrastructure-discovery](../ddd/contexts/infrastructure-discovery.md) |
| Security Operations | `src/services/security.service.ts` · `src/models/security-event.model.ts` | [security-operations](../ddd/contexts/security-operations.md) |
| AI Intelligence | `src/services/ai.service.ts` · `src/types/index.ts` (AIAnalysis, AIContext) | [ai-intelligence](../ddd/contexts/ai-intelligence.md) |
| Compliance & Risk | `src/services/compliance.service.ts` · `src/controllers/compliance.controller.ts` | [compliance-and-risk](../ddd/contexts/compliance-and-risk.md) |
| Performance & Observability | `src/services/performance.service.ts` · `src/controllers/performance.controller.ts` | [performance-and-observability](../ddd/contexts/performance-and-observability.md) |
| Audit & Logging | `src/middleware/audit.middleware.ts` · `src/utils/logger.ts` | [audit-and-logging](../ddd/contexts/audit-and-logging.md) |
| Dashboard & Reporting | `src/services/dashboard.service.ts` | [dashboard-and-reporting](../ddd/contexts/dashboard-and-reporting.md) |

The relationships between them — upstream/downstream, conformist, anti-corruption
layers — are in [`ddd/context-map.md`](../ddd/context-map.md).

## 4. Cross-cutting concerns

- **Authentication / authorisation**: JWT (access 15m, refresh 7d) + Redis-backed
  session tracking, RBAC with conditional permissions
  ([ADR-0006](../adr/0006-jwt-stateless-auth-with-rotation.md),
  [ADR-0009](../adr/0009-rbac-with-conditional-permissions.md)).
- **Rate limiting**: Redis-backed sliding window, separate budget for `/auth`
  endpoints ([ADR-0014](../adr/0014-rate-limiting-redis-backed-sliding-window.md)).
- **Audit**: every authenticated request and every security-relevant event is logged
  to a `SecurityEvent` document and structured Winston log
  ([ADR-0015](../adr/0015-structured-logging-with-winston.md)).
- **Configuration**: 12-factor — all configuration via environment variables, layered
  in `src/config/index.ts`. Secrets via Kubernetes Secrets in production
  ([ADR-0018](../adr/0018-secrets-management-env-and-k8s-secrets.md)).

## 5. Deployment

- Multi-stage Docker build (`docker/Dockerfile`), non-root `uid 1001`, read-only
  rootfs, `dumb-init` for signal handling
  ([ADR-0016](../adr/0016-container-security-non-root-readonly-root.md)).
- Kubernetes manifests in `k8s/`: Deployment with 3 replicas, `RollingUpdate`
  (`maxUnavailable=1`), `PodDisruptionBudget`, `NetworkPolicy`, `ResourceQuota`,
  StatefulSets for MongoDB and Redis
  ([ADR-0017](../adr/0017-kubernetes-deployment-strategy.md)).
- CI/CD via GitHub Actions (`.github/workflows/`): lint → typecheck →
  unit/integration → e2e → container build → push to GHCR.

## 6. How to use this documentation

- When you make a non-trivial technology or structural choice, **add a new ADR**
  using `../adr/template.md`. Number it sequentially. Never edit accepted ADRs in
  place — write a new one and mark the old one `Superseded by ADR-XXXX`.
- When you change the meaning of a domain term or move responsibility between
  contexts, **update the relevant DDD doc** and the ubiquitous-language glossary.
- Keep ADRs short (one decision, one page). Keep DDD docs grounded in code — every
  aggregate, entity and value object should map to a real file/symbol.
