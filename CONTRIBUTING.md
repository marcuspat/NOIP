# Contributing to NOIP

Thank you for your interest in contributing to the NetOps Intelligence
Platform. This guide documents the **actual** workflow used on the
`claude/adr-ddd-documentation-uNdZ2` mission branch — commands, branch
model, code-review gates, and the ADR-driven decision process.

If you are looking for install / run / test instructions, see:

- [`README.md`](./README.md) — elevator pitch + quick install.
- [`docs/INSTALL.md`](./docs/INSTALL.md) — developer / CI / production
  install paths.
- [`docs/TESTING.md`](./docs/TESTING.md) — unit / contract / benchmark /
  integration matrix.
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — operational playbook.

---

## Prerequisites

- **Node.js 18+** (LTS recommended) — see ADR-0002.
- **npm** (bundled with Node 18+) — we use `npm ci` for deterministic
  installs.
- **Docker + Compose v2** — for spinning up Mongo + Redis locally via
  `docker/docker-compose.yml`.
- **Git 2.30+** — required for the husky + `detect-secrets` pre-commit
  hook (ADR-0025).
- **Python 3.11+** (CI only) — hosts the `detect-secrets` binary.

NOIP itself is TypeScript / Node.js end-to-end. There is no Python
service in the production runtime; the only Python you need is
`detect-secrets` for the pre-commit hook.

---

## Development setup

```bash
# Fork on GitHub, then:
git clone git@github.com:<you>/NOIP.git
cd NOIP
git remote add upstream https://github.com/marcuspat/NOIP.git

# Install dependencies + the pre-commit hook
npm ci
npm run prepare      # installs husky + detect-secrets via scripts/install-git-hooks.cjs

# Bring up Mongo + Redis (optional — needed for integration tests)
docker compose -f docker/docker-compose.yml up -d mongodb redis

# Run the dev server
npm run dev

# Run the unit suite
npm test
```

Expected unit suite: **1025/1025 across 113 suites**. If you see fewer
tests passing on a clean clone, file an issue.

See [`docs/INSTALL.md`](./docs/INSTALL.md) for the full install matrix
including CI and production paths.

---

## Branch model

The active mission branch is `claude/adr-ddd-documentation-uNdZ2`.
Branch from it (not from `main`) for any change that touches the
bounded-context refactor or production-readiness checklist.

Branch naming:

| Prefix | Use for |
|--------|---------|
| `feat/<short-name>` | New feature or capability. |
| `fix/<short-name>` | Bug fix. |
| `docs/<short-name>` | Documentation-only change. |
| `chore/<short-name>` | Tooling, lockfile bumps, CI tweaks. |
| `refactor/<short-name>` | Internal restructure with no behaviour change. |
| `test/<short-name>` | Test-only additions. |

Keep branches short-lived and rebase against the mission branch
frequently. Long-running feature branches drift hard against the
context-extraction work.

---

## ADR-driven decision process

Material design changes land an ADR **before** the code. The pattern:

1. Open a draft ADR under `docs/architecture/adr/<next-number>-<slug>.md`
   following the [template](./docs/architecture/adr/template.md) (MADR
   3.0 lite — Status, Context, Decision Drivers, Considered Options,
   Decision Outcome, Consequences, References).
2. Status starts as `Proposed`. Open a PR; tag it `adr` for review.
3. Once accepted, set status to `Accepted` and merge the ADR.
4. Implement against the ADR. When the implementation lands, add an
   `Implementation:` line at the top of the ADR pointing at the commit
   range that fulfils it (see ADR-0006 for the canonical example).

ADRs are **immutable once accepted**. Superseding decisions get a new
ADR that references the old one (`Supersedes ADR-XXXX`).

Light-touch changes (a new domain method, a refactor inside one
bounded context, a test) do not need an ADR — judgement call. When in
doubt, ask in the PR.

---

## Commit messages

Conventional Commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`,
`build`, `ci`, `merge`. Scope is usually the bounded context
(`feat(audit): ...`, `feat(iam): ...`, `feat(observability): ...`).

Recent merge commits on the mission branch are good models — `git log
--oneline -20`.

---

## Pull request gates

Every PR must pass:

```bash
npm run lint:check    # eslint, 0 errors
npm run typecheck     # tsc --noEmit, 0 errors
npm run build         # tsc emit, exits 0
npm test              # 1025/1025 unit tests
```

`npm run pretest` chains lint; `npm run prebuild` chains lint +
typecheck. CI runs all four explicitly so a green local
`npm test` is not enough — typecheck must also exit 0.

### Coverage

The Jest config enforces 80% on branches / functions / lines /
statements ([`jest.config.cjs`](./jest.config.cjs)). Lower coverage
fails CI. Security-critical paths (auth, audit, rate limit, MFA)
should aim for 100% line coverage.

### Pre-commit hook

`detect-secrets` is wired to `pre-commit` via husky. It scans staged
files against `.secrets.baseline`. Do **not** bypass with
`--no-verify`. If you have a legitimate false positive, update the
baseline:

```bash
npm run secrets:baseline
```

and commit the regenerated `.secrets.baseline` in the same PR.

---

## Code style

- **TypeScript** — strict mode, no `any` in new code (existing `any`
  warnings in `src/types/` are tracked, do not add to them).
- **Formatting** — Prettier, run via `npm run format` (writes) or
  `npm run format:check` (CI gate).
- **Imports** — `eslint-plugin-import`'s `no-restricted-paths` rules
  enforce bounded-context isolation (ADR-0010 / ADR-0011 / ADR-0022).
  Cross-context calls must go through the target context's
  `api/index.ts` barrel.
- **Logging** — Winston via `src/utils/logger.ts`. No `console.log` in
  shipped code; the lint rule will catch it.

---

## Testing requirements

| Change touches | Required tests |
|----------------|----------------|
| Domain logic in a context | Unit tests under `src/contexts/<ctx>/**/__tests__/` or `tests/unit/<ctx>/`. |
| HTTP route or middleware | Unit test against a stub Express app; integration test under `tests/integration/` when integration suite is unblocked. |
| Adapter against an external API | Contract test under `tests/contract/<provider>/`, skip-gated on env/binary availability. |
| Performance-sensitive path | Add a `.bench.test.ts` under `tests/performance/`; record baseline in `PRODUCTION_READINESS.md` §5. |
| Cross-context interaction | Domain event handled by an audit subscriber under `src/contexts/audit/`. |

See [`docs/TESTING.md`](./docs/TESTING.md) for layer-by-layer guidance.

---

## Reporting issues

- **Security vulnerabilities** — see [`SECURITY.md`](./SECURITY.md). Do
  NOT open public GitHub issues for security bugs.
- **Bugs** — open a GitHub Issue with reproduction steps, the relevant
  `git rev-parse HEAD`, and the exact `npm test` output.
- **Feature requests** — open a GitHub Issue tagged `enhancement`; for
  anything that warrants an ADR, include a one-paragraph problem
  statement so the design conversation can happen in the PR.

---

## License

By contributing you agree that your contributions are licensed under
the project's [MIT License](./LICENSE).
