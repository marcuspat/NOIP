# Architecture Decision Records (ADRs)

This directory captures the significant architectural decisions for the NOIP
platform. Every record is a self-contained document explaining the context, the
forces in play, the options that were considered, the option that was chosen,
and the consequences of that choice.

## Why ADRs?

- **Memory** — capture *why* a decision was taken, not just *what* was decided.
- **Onboarding** — give new contributors a concise tour of the platform.
- **Change control** — make superseding a decision an explicit, traceable act.

## Format

We use the [MADR](https://adr.github.io/madr/) lite template. See
[`template.md`](./template.md).

## Lifecycle

| Status | Meaning |
|--------|---------|
| `Proposed` | Draft, under discussion. |
| `Accepted` | Active, drives implementation. |
| `Deprecated` | No longer recommended; existing code may still rely on it. |
| `Superseded by ADR-NNNN` | Replaced; see the linked ADR. |

ADRs are **immutable once accepted** except for status field updates and
back-references. Significant changes require a *new* ADR that explicitly
supersedes the prior one.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](./0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](./0002-typescript-nodejs-stack.md) | TypeScript + Node.js stack | Accepted |
| [0003](./0003-express-web-framework.md) | Express as web framework | Accepted |
| [0004](./0004-mongodb-primary-datastore.md) | MongoDB as primary datastore | Accepted |
| [0005](./0005-redis-cache-and-sessions.md) | Redis for cache and session storage | Accepted |
| [0006](./0006-jwt-authentication.md) | JWT-based authentication | Accepted |
| [0007](./0007-argon2-password-hashing.md) | Argon2 password hashing | Accepted |
| [0008](./0008-rbac-authorization-model.md) | RBAC with permissions model | Accepted |
| [0009](./0009-mfa-totp-strategy.md) | Multi-factor authentication strategy | Accepted |
| [0010](./0010-layered-service-architecture.md) | Layered service architecture | Accepted |
| [0011](./0011-bounded-contexts-and-modular-monolith.md) | Modular monolith with bounded contexts | Accepted |
| [0012](./0012-anthropic-claude-ai-integration.md) | Anthropic Claude integration for AI analysis | Accepted |
| [0013](./0013-rag-knowledge-base-chromadb.md) | RAG knowledge base on ChromaDB | Accepted |
| [0014](./0014-kubernetes-native-deployment.md) | Kubernetes-native deployment | Accepted |
| [0015](./0015-docker-multi-stage-builds.md) | Docker multi-stage builds | Accepted |
| [0016](./0016-rate-limiting-strategy.md) | Rate limiting strategy | Accepted |
| [0017](./0017-audit-logging-strategy.md) | Audit logging strategy | Accepted |
| [0018](./0018-security-event-domain-events.md) | Security events as domain events | Accepted |
| [0019](./0019-feature-flag-config-strategy.md) | Configuration & feature flags via environment | Accepted |
| [0020](./0020-health-check-and-graceful-shutdown.md) | Health checks and graceful shutdown | Accepted |
| [0021](./0021-testing-strategy-jest-playwright.md) | Testing strategy: Jest + Playwright | Accepted |
| [0022](./0022-eslint-prettier-code-quality.md) | ESLint + Prettier code-quality gates | Accepted |
| [0023](./0023-prometheus-observability.md) | Prometheus-based observability | Accepted |
| [0024](./0024-helmet-cors-security-headers.md) | Helmet + CORS security headers | Accepted |
| [0025](./0025-secrets-management.md) | Secrets management | Accepted |
| [0026](./0026-evolution-to-microservices.md) | Evolution path to microservices | Proposed |
