# Domain-Driven Design Documentation

This directory contains the strategic and tactical Domain-Driven Design
artefacts for NOIP. Together with the [ADRs](../adr/) they form the complete
blueprint of the platform.

## Reading order

1. [01 — Strategic design](./01-strategic-design.md) — domain vision,
   subdomains, and the high-level model.
2. [02 — Ubiquitous language](./02-ubiquitous-language.md) — the glossary that
   binds business and code.
3. [03 — Bounded contexts](./03-bounded-contexts.md) — list and intent of every
   bounded context.
4. [04 — Context map](./04-context-map.md) — integration patterns
   (Customer/Supplier, Conformist, Anti-Corruption Layer, Open Host Service,
   Published Language, Shared Kernel) between contexts.
5. Per-context tactical design:
   - [05 — IAM](./05-context-iam.md)
   - [06 — Infrastructure Discovery](./06-context-infrastructure-discovery.md)
   - [07 — Security & Compliance](./07-context-security-compliance.md)
   - [08 — AI Analysis](./08-context-ai-analysis.md)
   - [09 — Performance](./09-context-performance.md)
   - [10 — Dashboard & Reporting](./10-context-dashboard.md)
   - [11 — Audit & Observability](./11-context-audit-observability.md)
6. Cross-cutting tactical artefacts:
   - [12 — Domain events](./12-domain-events.md)
   - [13 — Aggregate catalogue](./13-aggregates-and-entities.md)
   - [14 — Repositories & persistence](./14-repositories-and-persistence.md)
   - [15 — Application services](./15-application-services.md)
   - [16 — Anti-corruption layers](./16-anti-corruption-layers.md)
7. [17 — Implementation roadmap](./17-implementation-roadmap.md) — sequencing
   from current state to fully implemented platform.

## Notation

We use the standard DDD vocabulary:

- **Domain** — the problem space (NetOps Intelligence).
- **Subdomain** — a slice of the domain (Core / Supporting / Generic).
- **Bounded Context** — a unit of model consistency; one ubiquitous language
  per context.
- **Aggregate** — consistency boundary; a cluster of entities and value
  objects.
- **Entity** — an object with identity that persists across state changes.
- **Value Object** — immutable object defined by its attributes.
- **Domain Event** — a fact that happened in the domain.
- **Repository** — abstraction over persistence for an aggregate.
- **Application Service** — orchestrates use cases; thin layer between the
  HTTP edge and the domain.
- **Domain Service** — domain logic that does not naturally live on an entity
  or value object.
- **Anti-Corruption Layer (ACL)** — translation layer between models that
  must not be allowed to bleed into each other.
- **Open Host Service / Published Language** — a deliberately stable contract
  exposed to other contexts.

## Diagram conventions

Diagrams are rendered with [Mermaid](https://mermaid.js.org/) so they render
inline on GitHub.
