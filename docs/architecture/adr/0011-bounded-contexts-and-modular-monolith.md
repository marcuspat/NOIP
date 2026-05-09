# ADR-0011: Modular monolith organised by bounded context

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, Architecture Working Group
- **Tags:** architecture, ddd, modularity

## Context and Problem Statement

NOIP spans several distinct subdomains (IAM, Discovery, Security/Compliance,
AI Analysis, Performance, Dashboard, Audit). Premature decomposition into
microservices will hurt velocity given the team size; a flat monolith will
hurt maintainability and force unwanted coupling between subdomains.

## Decision Drivers

- DDD bounded contexts (see DDD-03) should be visible in the source tree.
- Cross-context calls should go through explicit application-service APIs,
  not random imports from one context's models into another's services.
- The architecture must permit context-by-context extraction into separate
  services without large rewrites.

## Considered Options

1. **Modular monolith** — single deployable, but folders per bounded context
   with explicit public APIs.
2. **Microservices from day one.**
3. **Flat monolith.**

## Decision Outcome

**Chosen option:** **Modular monolith**. The runtime is the single
`noip-platform` Express process (`src/app.ts`), but the source tree migrates
toward:

```
src/
├── contexts/
│   ├── iam/
│   │   ├── api/          # public application services + types (other contexts depend ONLY on this)
│   │   ├── application/  # use-case services
│   │   ├── domain/       # entities, value objects, domain services
│   │   ├── infrastructure/ # Mongoose repositories, redis stores
│   │   └── http/          # routes + controllers
│   ├── discovery/
│   ├── security/
│   ├── ai/
│   ├── performance/
│   ├── dashboard/
│   └── audit/
├── shared/
│   ├── kernel/            # truly cross-cutting types (ids, time, events)
│   ├── observability/
│   └── http/
├── app.ts
└── index.ts
```

Until this migration is complete, we treat the existing flat layout as the
*current* manifestation and use lint rules / code review to enforce the same
boundaries.

### Public-API rule

Each context exposes a single barrel module (`contexts/<name>/api/index.ts`).
Cross-context code MAY only import from `…/api`. Any other import is a build
error.

### Cross-context collaboration patterns

| Pattern | Example | Notes |
|---------|---------|-------|
| Application-service call | `iam.api.getUserProfile(userId)` | Synchronous, in-process. |
| Domain event | `audit` subscribes to `iam.user.locked` | In-process event bus today; broker-backed in the future (ADR-0026). |
| Read-model snapshot | `dashboard` reads `security.api.getMetricsSnapshot()` | No direct DB queries across contexts. |
| Anti-corruption layer | `ai` ↔ Anthropic / Python scripts | DDD-16. |

### Positive Consequences

- Velocity of a monolith with the architectural hygiene of microservices.
- Trivial extraction to a microservice: copy the folder, replace in-process
  calls with HTTP/gRPC stubs, point at its own Mongo collections.

### Negative Consequences / Trade-offs

- Discipline tax on PR review.
- Single deploy / blast radius until extraction.

## Pros and Cons of the Options

### Modular monolith

- 👍 Velocity, simple ops, easy local dev.
- 👎 Shared DB by default; needs lint enforcement.

### Microservices day-one

- 👍 Strongest isolation.
- 👎 We do not yet have the team or operational maturity (service mesh,
  distributed tracing, schema registries).

### Flat monolith

- 👍 Easiest to write.
- 👎 Has been shown to silently couple contexts; hardest to refactor later.

## References

- DDD-03, DDD-04 (bounded contexts and context map)
- ADR-0010 (layered architecture)
- ADR-0026 (microservices evolution)
