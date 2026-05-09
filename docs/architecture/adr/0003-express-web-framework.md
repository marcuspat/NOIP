# ADR-0003: Express as the web framework

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering
- **Tags:** framework, http

## Context and Problem Statement

We need an HTTP framework for the NOIP API. It must support:

- middleware composition (CORS, Helmet, compression, rate limiting, audit,
  morgan-style logging, error handling),
- a Router abstraction we can mount per bounded context,
- a deep ecosystem of well-maintained middleware,
- compatibility with Passport for SSO/OIDC strategies and `express-validator`
  for request validation.

## Decision Drivers

- Mature middleware ecosystem.
- Familiarity for contributors.
- Stability and LTS-style release cadence.
- Compatibility with our chosen auth, rate-limit, and validation libraries.

## Considered Options

1. **Express 5** — incumbent in `package.json`.
2. **Fastify** — faster, schema-first.
3. **NestJS** — opinionated, decorator-based, DI built-in.
4. **Hono / Koa** — lightweight, modern.

## Decision Outcome

**Chosen option:** **Express 5** as the HTTP framework, paired with a
hand-rolled service/repository layer (see ADR-0010). Bounded-context routers
are mounted under `/api/<context>` (e.g. `/api/discovery`, `/api/security`,
`/api/ai`, `/api/dashboard`, `/api/performance`, `/api/compliance`,
`/api/auth`).

### Positive Consequences

- Direct, minimal abstraction; easy onboarding.
- Existing middleware (Helmet, CORS, compression, rate limiter, Passport)
  works without adapters.
- Clear mapping from a bounded context to an Express `Router` instance.

### Negative Consequences / Trade-offs

- No built-in dependency injection — we accept the cost of manual wiring in
  `src/app.ts` in exchange for transparency. If wiring grows unwieldy we will
  consider Inversify or NestJS migration (separate ADR).
- Per-route validation must be added explicitly (`express-validator`).

## Pros and Cons of the Options

### Express 5

- 👍 Largest middleware ecosystem in Node.
- 👍 Already adopted by the codebase (`src/app.ts`).
- 👎 No DI / opinionated module system out of the box.

### Fastify

- 👍 Faster, schema-driven validation.
- 👎 Smaller middleware ecosystem; Passport integration less polished;
  migration cost not justified by current latency budgets.

### NestJS

- 👍 Opinionated structure, DI, modules; aligns with bounded contexts.
- 👎 Heavyweight; steeper learning curve; many features we do not yet need.

### Hono / Koa

- 👍 Modern, minimal.
- 👎 Smaller ecosystem; less battle-tested for the auth and rate-limit
  scenarios we require.

## References

- `src/app.ts` — root Express application, route mounting.
- `src/routes/*` — per-context routers.
- ADR-0010 (layered service architecture)
- ADR-0016 (rate limiting)
- ADR-0024 (Helmet + CORS security headers)
