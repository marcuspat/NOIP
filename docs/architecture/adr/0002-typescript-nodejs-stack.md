# ADR-0002: TypeScript + Node.js stack for backend services

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering
- **Tags:** language, runtime, foundation

## Context and Problem Statement

NOIP exposes HTTP APIs that mediate between Kubernetes/cluster scanners, an AI
analysis pipeline, and a browser-based dashboard. The service layer must:

- run on commodity Linux containers with predictable cold-start cost,
- offer a strong third-party ecosystem for crypto, MongoDB, Redis, Express
  middleware, and security libraries,
- be ergonomic for a team comfortable with JavaScript/TypeScript,
- give us static typing for safety in an evolving multi-context model.

## Decision Drivers

- Type safety for evolving domain models (auth, security events, AI requests).
- Mature ecosystem for the integrations we need (Mongoose, ioredis, Helmet,
  passport, jose).
- Single language across backend services, scripts, and Playwright e2e.
- Acceptable performance for I/O-bound workloads (HTTP, DB, AI calls).

## Considered Options

1. **TypeScript on Node.js 18+ (LTS)** — current direction.
2. **Plain JavaScript on Node.js** — no compile step.
3. **Go** — compiled, statically typed, strong stdlib.
4. **Python (FastAPI)** — already used for AI scripts (`scripts/ai_analysis.py`,
   `scripts/generate_dashboard.py`).
5. **Rust (Axum / Actix)** — best raw performance, steepest learning curve.

## Decision Outcome

**Chosen option:** **TypeScript on Node.js 18+ LTS** for the HTTP/service
layer. Python is retained for offline scripts (RAG ingestion, dashboard
generation, file hashing) where its data-tooling ecosystem is superior; the
boundary between TypeScript services and Python scripts is treated as an
integration boundary (see ADR-0011 and DDD-16).

### Positive Consequences

- One typed language for HTTP, business logic, models, and tests.
- Direct access to the npm ecosystem (`mongoose`, `ioredis`, `jose`, `argon2`,
  `passport`, `helmet`, `express-rate-limit`, `speakeasy`).
- Familiar stack for the broader hiring market.

### Negative Consequences / Trade-offs

- Build step (`tsc`) and slower per-request CPU compared to Go/Rust.
- Two-language stack (TS + Python) requires explicit ACL between them.

## Pros and Cons of the Options

### TypeScript / Node.js

- 👍 Static typing, single-language stack, mature ecosystem.
- 👎 Single-threaded event loop limits CPU-bound workloads (but our workloads
  are I/O-bound; CPU-heavy AI work is offloaded to Claude / Python scripts).

### Plain JavaScript

- 👍 No build step.
- 👎 Loss of type safety in a multi-context domain model is unacceptable.

### Go

- 👍 Excellent performance, native concurrency.
- 👎 Smaller ecosystem for Mongoose-equivalent ODMs, less ergonomic for the
  current team, would not bridge to the Python-side AI work any more cleanly.

### Python (FastAPI)

- 👍 Already used for AI scripts.
- 👎 Weaker static-typing story; runtime overhead and packaging issues at
  production scale; we want to reserve Python for batch/AI work.

### Rust

- 👍 Highest performance, memory safety.
- 👎 Velocity penalty that is hard to justify for an I/O-bound API.

## References

- `package.json` — `typescript ^5.9`, `@types/node ^24`, `ts-node`, `tsc` build.
- ADR-0003 (Express)
- ADR-0011 (modular monolith)
