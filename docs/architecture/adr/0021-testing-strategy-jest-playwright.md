# ADR-0021: Testing strategy — Jest + Supertest + Playwright

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, QA
- **Tags:** testing, quality

## Context and Problem Statement

NOIP requires a test pyramid that:

- catches domain-logic regressions cheaply (unit),
- exercises the HTTP boundary against real Mongo/Redis (integration),
- validates the dashboard and core user journeys end-to-end (e2e),
- runs deterministically in CI on every PR.

The repo already includes Jest, Supertest, ts-jest, and Playwright.

## Decision Drivers

- Speed (unit tests <2 s on a developer laptop).
- Confidence on the HTTP and persistence boundary.
- Realistic UI flows for dashboard regressions.

## Considered Options

1. **Jest (unit + integration) + Supertest (HTTP) + Playwright (e2e).**
2. **Vitest** instead of Jest.
3. **Cypress** instead of Playwright.

## Decision Outcome

**Chosen option:** Option 1 — already configured.

### Test layout

```
tests/
├── unit/            # pure logic, no I/O; aliased mocks for repositories
├── integration/     # service + repository against ephemeral Mongo/Redis (Testcontainers)
├── e2e/             # Playwright UI flows
├── auth/            # IAM-specific scenarios spanning levels
├── compliance/
├── kubernetes/
├── performance/     # k6 / autocannon harnesses (smoke; load tests in dedicated env)
├── security/
└── container/       # docker image smoke tests
```

### Conventions

- File names `*.spec.ts` for unit/integration; `*.e2e.ts` for Playwright.
- One service per integration test file; bring up Mongo/Redis via
  Testcontainers fixtures in `tests/setup.ts`.
- Coverage gates: 80% lines / 80% branches for changed code; failure blocks
  PR merge.
- Forbidden: tests that rely on external network (Anthropic, public k8s)
  outside the `e2e-live` suite.

### CI orchestration

- `npm run lint:check` and `npm run typecheck` are pre-test gates
  (`pretest` script).
- `npm test` runs unit + integration in parallel sharded across CI workers.
- Playwright `e2e` runs on a separate, smaller worker pool against a deployed
  preview environment.
- Nightly: `e2e-live` runs against a long-lived staging cluster, including
  real Anthropic calls in a budget-capped account.

### Positive Consequences

- Existing toolchain; no new dependencies.
- Pyramid keeps PR feedback fast.

### Negative Consequences / Trade-offs

- Testcontainers requires a Docker daemon in CI (already provided).
- Playwright traces can be heavyweight; we keep retention to 7 days.

## References

- `jest.config.cjs`, `playwright.config.ts`
- `tests/setup.ts`
- ADR-0022 (lint / format)
