# NOIP Architecture Documentation

This directory contains the canonical architecture documentation for the
**NetOps Intelligence Platform (NOIP)**. It is organised in two complementary
parts:

| Section | Purpose |
|---------|---------|
| [`adr/`](./adr/) | **Architecture Decision Records** — point-in-time decisions, with context, options considered, the chosen option, and consequences. |
| [`ddd/`](./ddd/) | **Domain-Driven Design artefacts** — strategic design (subdomains, bounded contexts, context map), tactical design (aggregates, entities, value objects, domain events), and the ubiquitous language. |

These documents describe a target-state architecture that is consistent with
the current codebase (TypeScript/Node.js Express monolith with a services
layer, MongoDB + Redis, JWT-based auth, Kubernetes-native deployment, and
Claude AI integration) and provide the blueprint required to take NOIP from
its current state to a fully implemented platform. The documents are
**descriptive of intent and prescriptive for implementation**; no code changes
are made here.

---

## How to Read This Documentation

1. **Start with [`ddd/01-strategic-design.md`](./ddd/01-strategic-design.md)** to
   understand the problem domain, subdomains, and bounded contexts.
2. **Read the [Context Map](./ddd/04-context-map.md)** to see how contexts
   integrate.
3. **Read the [ADR index](./adr/README.md)** to see the cross-cutting technical
   decisions that shape the platform.
4. **Drill into individual context docs** (`ddd/05-context-iam.md`, etc.) for
   the tactical design (aggregates, entities, value objects, repositories,
   domain events) of each bounded context.
5. **Use the [implementation roadmap](./ddd/17-implementation-roadmap.md)** as
   a sequencing guide.

---

## Document Index

### Architecture Decision Records

See [`adr/README.md`](./adr/README.md) for the full list. Quick links:

- [ADR-0001 Record architecture decisions](./adr/0001-record-architecture-decisions.md)
- [ADR-0002 TypeScript + Node.js stack](./adr/0002-typescript-nodejs-stack.md)
- [ADR-0003 Express as web framework](./adr/0003-express-web-framework.md)
- [ADR-0004 MongoDB as primary datastore](./adr/0004-mongodb-primary-datastore.md)
- [ADR-0005 Redis for cache and session storage](./adr/0005-redis-cache-and-sessions.md)
- [ADR-0006 JWT-based authentication](./adr/0006-jwt-authentication.md)
- [ADR-0007 Argon2 password hashing](./adr/0007-argon2-password-hashing.md)
- [ADR-0008 RBAC with permissions model](./adr/0008-rbac-authorization-model.md)
- [ADR-0009 Multi-factor authentication strategy](./adr/0009-mfa-totp-strategy.md)
- [ADR-0010 Layered service architecture](./adr/0010-layered-service-architecture.md)
- [ADR-0011 Modular monolith with bounded contexts](./adr/0011-bounded-contexts-and-modular-monolith.md)
- [ADR-0012 Anthropic Claude integration for AI analysis](./adr/0012-anthropic-claude-ai-integration.md)
- [ADR-0013 RAG knowledge base on ChromaDB](./adr/0013-rag-knowledge-base-chromadb.md)
- [ADR-0014 Kubernetes-native deployment](./adr/0014-kubernetes-native-deployment.md)
- [ADR-0015 Docker multi-stage builds](./adr/0015-docker-multi-stage-builds.md)
- [ADR-0016 Rate limiting strategy](./adr/0016-rate-limiting-strategy.md)
- [ADR-0017 Audit logging strategy](./adr/0017-audit-logging-strategy.md)
- [ADR-0018 Security events as domain events](./adr/0018-security-event-domain-events.md)
- [ADR-0019 Configuration & feature flags via environment](./adr/0019-feature-flag-config-strategy.md)
- [ADR-0020 Health checks and graceful shutdown](./adr/0020-health-check-and-graceful-shutdown.md)
- [ADR-0021 Testing strategy: Jest + Playwright](./adr/0021-testing-strategy-jest-playwright.md)
- [ADR-0022 ESLint + Prettier code-quality gates](./adr/0022-eslint-prettier-code-quality.md)
- [ADR-0023 Prometheus-based observability](./adr/0023-prometheus-observability.md)
- [ADR-0024 Helmet + CORS security headers](./adr/0024-helmet-cors-security-headers.md)
- [ADR-0025 Secrets management](./adr/0025-secrets-management.md)
- [ADR-0026 Evolution path to microservices](./adr/0026-evolution-to-microservices.md)

### Domain-Driven Design

- [DDD-01 Strategic design](./ddd/01-strategic-design.md)
- [DDD-02 Ubiquitous language](./ddd/02-ubiquitous-language.md)
- [DDD-03 Bounded contexts overview](./ddd/03-bounded-contexts.md)
- [DDD-04 Context map](./ddd/04-context-map.md)
- [DDD-05 Identity & Access Management context](./ddd/05-context-iam.md)
- [DDD-06 Infrastructure Discovery context](./ddd/06-context-infrastructure-discovery.md)
- [DDD-07 Security & Compliance context](./ddd/07-context-security-compliance.md)
- [DDD-08 AI Analysis context](./ddd/08-context-ai-analysis.md)
- [DDD-09 Performance context](./ddd/09-context-performance.md)
- [DDD-10 Dashboard & Reporting context](./ddd/10-context-dashboard.md)
- [DDD-11 Audit & Observability context](./ddd/11-context-audit-observability.md)
- [DDD-12 Cross-context domain events](./ddd/12-domain-events.md)
- [DDD-13 Aggregate catalogue](./ddd/13-aggregates-and-entities.md)
- [DDD-14 Repositories & persistence](./ddd/14-repositories-and-persistence.md)
- [DDD-15 Application services](./ddd/15-application-services.md)
- [DDD-16 Anti-corruption layers](./ddd/16-anti-corruption-layers.md)
- [DDD-17 Implementation roadmap](./ddd/17-implementation-roadmap.md)

---

## Conventions

- **ADR format** follows [MADR 3.0](https://adr.github.io/madr/) lite with the
  sections: Status, Context, Decision Drivers, Considered Options, Decision
  Outcome, Consequences, References.
- **DDD notation** uses Eric Evans' vocabulary (Bounded Context, Aggregate,
  Entity, Value Object, Domain Event, Repository, Application Service,
  Anti-Corruption Layer, Context Map). Where Vaughn Vernon's refinements apply
  (e.g. Aggregate design rules, Domain Service vs. Application Service) we
  follow them.
- ADRs are **immutable once accepted**; superseding decisions get a new ADR
  that references the old one.
- DDD documents are **living** — they are updated as the model evolves, with
  changes recorded in commit history.
