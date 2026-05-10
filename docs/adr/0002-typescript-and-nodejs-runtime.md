# ADR-0002: TypeScript on Node.js as the primary runtime

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** runtime, language

## Context

NOIP is a security- and compliance-sensitive platform that integrates with
external HTTP APIs (Anthropic Claude, Kubernetes, SMTP), exposes a REST API,
and is operated by a small team. The team's existing strengths are JavaScript
and Python. The system is I/O-bound, not CPU-bound: most of its work is
network calls, Mongo/Redis queries, and JSON munging.

We needed to choose a runtime and language that:

1. Has first-class libraries for HTTP, Mongo, Redis, JWT, Argon2, and Speakeasy.
2. Supports strict typing — required for refactoring confidence on a
   security-critical codebase.
3. Has good async/concurrency primitives for I/O fan-out.
4. Has a healthy CI/CD ecosystem (Jest, Playwright, ESLint, Prettier).

## Decision

We use **TypeScript 5.x** in *strict* mode, compiled by `tsc` to ES modules,
running on **Node.js 18+** LTS. The build is configured in `tsconfig.json` with
`"strict": true`, `"isolatedModules": true`, and ESM (`"type": "module"` in
`package.json`).

## Alternatives considered

- **Plain JavaScript** — rejected. No compile-time guarantees on a
  security-critical codebase.
- **Go** — strong story for systems software but the team has weaker Go skills,
  and AI/HTTP/Mongo libraries are less idiomatic than the Node ecosystem.
- **Python (FastAPI)** — viable, but our existing libraries (Speakeasy,
  Mongoose, ioredis) have richer Node implementations, and async ergonomics in
  Python are still rougher than `async/await` in TS.
- **Rust** — too heavy a productivity tax for a team this size and an
  application that is overwhelmingly I/O-bound.

## Consequences

### Positive
- Strict typing surfaces a class of bugs at compile time.
- Vast npm ecosystem covers every external integration we need.
- Same language across server and tooling (CI scripts, tests).

### Negative / costs
- Build step required (`tsc` + ESM gotchas).
- Type definitions for some niche libraries (`@types/argon2`,
  `@types/passport-jwt`) need maintenance.
- Single-threaded — must be explicit about heavy CPU work (none today).

### Risks and mitigations
- *ESM/CJS interop pain.* Pinned to ESM throughout; we do not mix module
  systems within `src/`.
- *Node EOL cadence.* Track Node LTS; bump major versions in dedicated PRs.

## References

- `package.json` — `"type": "module"`, dev/runtime deps.
- `tsconfig.json` — strict TS configuration.
