# ADR-0003: Express 5 as the HTTP framework

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** http, framework

## Context

NOIP exposes a REST API for authentication, discovery, security operations,
compliance, performance and AI services. We needed an HTTP framework that:

1. Has a deep middleware ecosystem (Helmet, CORS, Morgan, rate-limit, audit).
2. Supports async route handlers with native error propagation.
3. Is well-known to contributors — minimum onboarding cost.
4. Composes naturally with Passport for JWT auth.

## Decision

We use **Express 5.1+** with TypeScript bindings (`@types/express`). Each
bounded context defines a `Router` in `src/routes/<context>.routes.ts`,
mounted from `src/app.ts` under `/api/v1/<context>`. Cross-cutting concerns
are implemented as Express middleware in `src/middleware/`.

## Alternatives considered

- **Fastify** — measurably faster, schema-based validation. Rejected because
  the maturity gap on Passport/Helmet integrations was non-trivial in 2025
  and the marginal RPS improvement was not the bottleneck for an I/O-bound,
  Mongo-backed service.
- **NestJS** — more structure, decorator-based DI, opinionated module system.
  Rejected as over-engineering for a service of this size; we prefer
  composing small Express routers and wiring services manually.
- **Hono / Koa** — Hono is excellent but ecosystem (Passport in particular)
  is thinner; Koa's middleware model is appealing but Express 5 absorbed the
  best of it (native promise support, cleaner error propagation).

## Consequences

### Positive
- Universally familiar; new contributors are productive immediately.
- Helmet, CORS, Morgan, express-rate-limit, express-validator are
  battle-tested and integrate trivially.
- Express 5's native async error handling makes error middleware simple.

### Negative / costs
- Slower than Fastify on synthetic benchmarks (not a real bottleneck for us).
- Less structural opinion than NestJS — we have to enforce module boundaries
  ourselves (see [ADR-0012](./0012-bounded-context-modular-monolith.md)).

### Risks and mitigations
- *Middleware ordering bugs.* All middleware is registered in one place
  (`src/app.ts`); ordering is reviewed in PRs touching that file.
- *Route sprawl.* Routers are scoped per bounded context, never shared.

## References

- `src/app.ts` — global middleware and router mounting.
- `src/routes/*.routes.ts` — per-context routers.
