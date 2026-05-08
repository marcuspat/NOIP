# NOIP — Domain-Driven Design Documentation

This directory describes NOIP's **domain model** using Domain-Driven Design.
The goal is twofold:

1. Make the language we use to talk about the system explicit and shared.
2. Make the boundaries between parts of the system explicit so they can be
   reviewed, defended, and (eventually) extracted into separate services.

If you are new to NOIP, start here, then read
[`../architecture/README.md`](../architecture/README.md) for the deployment
view, and the [`../adr/`](../adr/README.md) index for the *why* of any
specific decision.

## Contents

### Strategic design (whole-system)
- [`strategic-design.md`](./strategic-design.md) — domains and subdomains,
  core/supporting/generic classification, domain vision.
- [`context-map.md`](./context-map.md) — bounded contexts and the
  relationships between them (upstream/downstream, conformist, ACL,
  shared kernel).
- [`ubiquitous-language.md`](./ubiquitous-language.md) — glossary. Words
  in this list have a precise meaning in this codebase; do not synonym
  them in code or in conversation.
- [`domain-events.md`](./domain-events.md) — the cross-context events
  contexts publish and subscribe to.
- [`aggregates.md`](./aggregates.md) — global rules for designing
  aggregates in NOIP (identity, invariants, transactional boundaries).

### Tactical design (per bounded context)
Each context owns a folder under `contexts/`. The doc covers the
context's purpose, ubiquitous language, aggregates and entities, value
objects, domain services, repositories, and integration with neighbouring
contexts.

- [`contexts/identity-and-access.md`](./contexts/identity-and-access.md)
- [`contexts/infrastructure-discovery.md`](./contexts/infrastructure-discovery.md)
- [`contexts/security-operations.md`](./contexts/security-operations.md)
- [`contexts/ai-intelligence.md`](./contexts/ai-intelligence.md)
- [`contexts/compliance-and-risk.md`](./contexts/compliance-and-risk.md)
- [`contexts/performance-and-observability.md`](./contexts/performance-and-observability.md)
- [`contexts/audit-and-logging.md`](./contexts/audit-and-logging.md)
- [`contexts/dashboard-and-reporting.md`](./contexts/dashboard-and-reporting.md)

## Conventions

- **Aggregate names are nouns in PascalCase.** They map to a Mongoose
  model file, e.g. `User` ↔ `src/models/user.model.ts`.
- **Domain services live in `src/services/<context>.service.ts`.** They
  contain business logic; they are not just CRUD wrappers.
- **Cross-context calls go through service interfaces only.** No
  importing another context's Mongoose model directly. This is enforced
  by lint rules ([ADR-0012](../adr/0012-bounded-context-modular-monolith.md)).
- **Domain events** are described in `domain-events.md`. Today they are
  in-process; the contract is the same when we add a message bus later.

## How to evolve the docs

- Adding a new aggregate or moving responsibility between contexts is a
  documentation change *as well as* a code change. Both go in the same PR.
- The ubiquitous-language glossary is the source of truth for naming. If
  the code disagrees, the code is wrong (or the glossary needs an update
  — but that's a deliberate decision in the same PR).
- When two contexts find themselves needing the same concept with the
  same meaning, ask: should it be a *shared kernel* (small, slow-changing,
  e.g. `UserId`) or should one own it and the other consume via an ACL?
  Default to ACL.
