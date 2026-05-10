# ADR-0019: Testing strategy — Jest + Supertest + Playwright pyramid

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** testing, quality

## Context

NOIP is security-sensitive and operated by a small team. Refactoring
confidence depends on a test suite that:

1. Catches regressions in domain logic at unit-test speed.
2. Verifies HTTP contracts and middleware composition.
3. Exercises real browser behaviour for the dashboard.
4. Runs in CI on every PR in under ~10 minutes.

We do not aim for "100% coverage"; we aim for high coverage of the
hot paths and the security-critical paths.

## Decision

We use a **three-layer pyramid**:

- **Unit tests (Jest)** — `tests/unit/**`. Test pure domain logic,
  service methods (with mocked Mongo/Redis/HTTP), and middleware.
  Goal: fast (<10s for the suite locally), no I/O.
- **Integration tests (Jest + Supertest)** — `tests/integration/**`.
  Boot the Express app against a real ephemeral MongoDB and Redis
  (via test containers or `mongodb-memory-server`). Test full HTTP
  flows: register → login → MFA → protected endpoint.
- **E2E tests (Playwright)** — `tests/e2e/**`. Drive the dashboard in
  a real browser against a deployed test build. Cover the critical
  user journeys (login, view dashboard, run scan, view report).

CI gates merges on:

- `lint:check` — ESLint with `eslint-plugin-prettier`.
- `typecheck` — `tsc --noEmit`.
- `test:unit` and `test:integration` — both with junit/coverage
  output.
- `test:e2e` — runs against an ephemeral preview deploy.

Security-specific tests live in `tests/security/` and include:
- Auth flow tests (rotation, replay, account lockout).
- RBAC permission denial coverage.
- Redaction of sensitive fields in HTTP responses and logs.

## Alternatives considered

- **Mocha + Chai.** Equally capable; Jest's built-in mocking,
  snapshots, and watch mode make it the better default for new
  TypeScript projects.
- **Cypress** for E2E. Considered; Playwright's cross-browser story,
  parallelism, and headless trace viewer are stronger for our needs.
- **Skip integration, rely on E2E.** Slower feedback, harder to debug,
  poor coverage of failure paths.

## Consequences

### Positive
- Tight loop: unit tests run on every save; integration tests on
  every commit; E2E on PR.
- Real HTTP coverage of every controller via Supertest.
- Cross-browser coverage out of the box.

### Negative / costs
- Three test runners to maintain.
- E2E flakiness must be aggressively suppressed — known-flaky tests
  are quarantined, not retried.

### Risks and mitigations
- *Slow CI.* Integration tests share an in-process Mongo/Redis where
  possible; E2E tests run in parallel shards.
- *Drift between unit mocks and real services.* Integration tests
  cover the boundary; unit tests do not assert wire formats.

## References

- `jest.config.cjs`
- `playwright.config.ts`
- `tests/` — unit, integration, e2e, security subtrees.
- `.github/workflows/ci-cd.yml`
