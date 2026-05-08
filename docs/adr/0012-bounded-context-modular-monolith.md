# ADR-0012: Modular monolith with explicit bounded contexts

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** architecture, ddd

## Context

NOIP could plausibly be designed as:

- A single Express app (the current state).
- A handful of microservices (auth, discovery, AI, compliance, …).
- A serverless mesh of functions per endpoint.

The team is small. Operational headcount for a microservice fleet is
disproportionate to the value at the platform's current size, but we
also do not want a "big ball of mud" that makes future extraction
painful.

DDD supplies the framing: identify bounded contexts now, enforce their
boundaries in code, and defer the deployment decision until pressure
forces it.

## Decision

NOIP is a **modular monolith** with eight explicit bounded contexts
(see [`docs/ddd/context-map.md`](../ddd/context-map.md)):

1. Identity & Access
2. Infrastructure Discovery
3. Security Operations
4. AI Intelligence
5. Compliance & Risk
6. Performance & Observability
7. Audit & Logging
8. Dashboard & Reporting

Each context is implemented as a vertical slice in `src/`:
`models/<ctx>.*`, `services/<ctx>.service.ts`,
`controllers/<ctx>.controller.ts`, `routes/<ctx>.routes.ts`. **Cross-
context calls only go through service interfaces** — never a peer
context's Mongoose model directly.

Shared types live in `src/types/` and are dependency-free. Shared
infrastructure (Mongo, Redis, logger) lives in `src/database/` and
`src/utils/` and is consumed via constructor injection in services.

## Alternatives considered

- **True microservices today.** Premature: each context would carry its
  own deployment, observability, and inter-service contract overhead
  for a value we do not yet realise.
- **Unstructured monolith.** Easy to start; impossible to extract.
- **Hexagonal-ports-and-adapters per context, with shared kernel.** A
  refinement we may adopt incrementally; today's structure is the
  pragmatic minimum.

## Consequences

### Positive
- One process to run, observe, and deploy.
- Refactor across contexts with one change set when truly needed.
- Boundaries documented in code and DDD docs — extraction to a service
  later means moving one slice and substituting an HTTP client for the
  service interface.

### Negative / costs
- Discipline burden: we must actively reject "just a quick import"
  shortcuts in PR review.
- A failure in one context (e.g. a runaway AI loop) can affect the
  whole process; mitigated by per-route timeouts and bulkheads.

### Risks and mitigations
- *Boundary erosion.* Lint rule `no-restricted-imports` forbids
  cross-context model imports. PR reviewers enforce service-only
  boundaries.
- *Hidden coupling via shared types.* `src/types/` is reviewed; types
  must not encode behaviour.

## References

- `docs/ddd/context-map.md` — context map and integration patterns.
- `docs/ddd/contexts/*.md` — per-context tactical docs.
- `src/` — physical layout mirrors logical contexts.
