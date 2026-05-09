# ADR-0010: Layered service architecture (controllers, services, repositories)

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering
- **Tags:** architecture, code-organization

## Context and Problem Statement

The codebase already shows a layered split: `src/controllers/`, `src/services/`,
`src/models/`, `src/middleware/`, `src/routes/`. We need an ADR that makes the
allowed dependencies between layers explicit and enforceable.

## Decision Drivers

- Keep HTTP concerns out of business logic.
- Keep persistence (Mongoose specifics) behind a repository boundary so we can
  unit-test services without spinning up MongoDB.
- Make domain logic (validation, invariants) live in a layer that does not
  depend on Express or Mongoose.

## Considered Options

1. **Classic layered architecture: routes → controllers → application services →
   domain services → repositories → models.**
2. **Hexagonal / ports-and-adapters from day one.**
3. **Vertical slices** (one folder per feature).

## Decision Outcome

**Chosen option:** Option 1 with the discipline of *keeping domain models
framework-free*. This is a pragmatic stop on the way to Option 2 (hexagonal),
which we will adopt context by context as complexity warrants.

### Layers and dependency rules

```
HTTP Edge       routes/        (Express Router definitions)
                  │
Controllers     controllers/   (HTTP <-> DTO marshalling)
                  │
App Services    services/      (use-cases, orchestration, transactions)
                  │
Domain          models/, types/ (entities, value objects, invariants)
                  │
Repositories    database/      (Mongoose, ioredis adapters)
```

**Allowed imports** (top → bottom only):

- `routes` ⇒ `controllers`
- `controllers` ⇒ `services`, `types`
- `services` ⇒ `services` (peers), `models`, `types`, `repositories`
- `repositories` ⇒ `models`, `types`, persistence libraries
- `models`, `types` ⇒ no application code

**Forbidden imports**:

- `models` / `types` MUST NOT import `services`, `controllers`, or anything
  HTTP- or Mongoose-specific.
- `services` MUST NOT import `express` or call `req`/`res` directly.
- `controllers` MUST NOT call Mongoose; they must go through services.

### Cross-cutting

- **Logger** (`src/utils/logger.ts`) is allowed everywhere.
- **Config** (`src/config/`) is allowed everywhere.
- **Error types** are defined in a `src/errors/` module that all layers may
  import; HTTP error mapping happens in a single Express error handler.

### Per-bounded-context layout

Within each context, the layout mirrors the global one:

```
src/services/auth.service.ts
src/controllers/auth.controller.ts
src/routes/auth.routes.ts
src/models/user.model.ts
src/models/role.model.ts
src/models/permission.model.ts
src/models/session.model.ts
```

When complexity in a context grows, it is promoted to its own folder
(`src/contexts/iam/...`) — see ADR-0011.

### Positive Consequences

- Clear, enforceable rules for new code.
- Services unit-testable with in-memory fakes for repositories.
- Migration path to hexagonal is incremental.

### Negative Consequences / Trade-offs

- Some boilerplate (DTO ↔ entity mapping).
- Discipline-dependent: enforcement requires lint rules
  (`eslint-plugin-import` `no-restricted-paths`) — we will add these as a
  follow-up.

## References

- `src/controllers/`, `src/services/`, `src/models/`, `src/routes/`
- ADR-0011 (modular monolith)
- ADR-0022 (lint rules)
