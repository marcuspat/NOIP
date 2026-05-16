# TESTING — NetOps Intelligence Platform (NOIP)

NOIP's test pyramid follows ADR-0021. The fast loop is the Jest unit
suite (`npm test`). Slower or environment-coupled suites live in
dedicated Jest configs and run on opt-in commands, so the default
developer loop stays under a minute.

| Layer | Command | Default? | Skip-gate | Current state |
|-------|---------|----------|-----------|---------------|
| Unit | `npm test` | ✅ | none | **1025/1025 across 113 suites green** |
| Contract — AI / Chroma | `npm run test:contract` | ❌ | `CHROMA_URL` env | Skip-clean without env |
| Contract — Security CLIs | `npm run test:contract:security` | ❌ | scanner binary on `PATH` | Skip-clean without binaries |
| Benchmarks | `npx jest --testPathPatterns=tests/performance` | ❌ | none | All baselines in `PRODUCTION_READINESS.md` §5 |
| Integration | `npm run test:integration` | ❌ | Mongo + Redis | **Currently failing** — legacy refactor remnants |
| E2E (Playwright) | `npm run test:e2e` | ❌ | running app + browsers | Tracked under ADR-0021 |

Jest config files:

- [`jest.config.cjs`](../jest.config.cjs) — default config used by
  `npm test`, `npm run test:unit`, and `npm run test:integration`. It
  excludes `tests/contract/` via `testPathIgnorePatterns`.
- [`jest.contract.config.cjs`](../jest.contract.config.cjs) — AI / Chroma
  contract tests. Runs in-band with a 30 s timeout.
- [`jest.contract.security.config.cjs`](../jest.contract.security.config.cjs)
  — CLI scanner contract tests. Runs in-band with a 60 s timeout.

---

## Unit suite (`npm test`)

This is the fast loop. Every change must land it green.

```bash
npm test                       # full unit suite
npm run test:watch             # watch mode
npm run test:unit              # alias: jest --testPathPatterns=unit
npm run test:coverage          # writes coverage/{lcov.info,html/}
```

- **Layout:** Unit tests live colocated under `src/**/*.test.ts` and
  under `tests/unit/`. The Jest config's `roots` cover both.
- **Coverage threshold:** 80% on branches, functions, lines, statements
  (`jest.config.cjs`). CI rejects coverage regressions.
- **Pretest gate:** `npm test` runs `npm run lint:check` first via the
  `pretest` script. A lint error fails the test command before Jest
  even starts.
- **External dependencies:** none. Mongoose, Redis, the Anthropic
  client, and `child_process` are all stubbed at module boundaries
  (search for `jest.mock(` to find them). If a unit test starts
  needing a real datastore it belongs in `tests/integration/`.

---

## Contract tests

Contract tests pin our adapters to real third-party shapes. They are
**not** wired into `npm test` because they require live services or
binaries. They MUST skip-gate cleanly when the dependency is absent
so they can sit dormant in CI until someone provisions the resource.

### AI / Chroma (`npm run test:contract`)

```bash
# With a local Chroma running:
docker run -d -p 8000:8000 chromadb/chroma:latest
export CHROMA_URL=http://localhost:8000
npm run test:contract

# Without CHROMA_URL set, every suite under tests/contract/ai/ skips.
```

What's covered:

- `ChromaAdapter` against the real `/api/v1/...` shape.
- `AnthropicAdapter` retry / circuit-breaker behaviour against the live
  SDK (gated on `ANTHROPIC_API_KEY`).
- Prompt-composer guardrails — token-budget enforcement against the
  current model's tokenizer.

### Security CLIs (`npm run test:contract:security`)

```bash
# Each scanner suite skip-gates on whether its binary is on PATH:
which trivy kube-bench kube-linter gitleaks
npm run test:contract:security
```

What's covered:

- `TrivyAdapter` — JSON output shape and exit-code semantics.
- `KubeBenchAdapter` — CIS check JSON shape.
- `KubeLinterAdapter` — workload lint JSON shape.
- `GitleaksAdapter` — secret-scan SARIF / JSON output.

These adapters are the real-CLI side of the ADR-0007 split; the
built-in scanners stay covered by the unit suite.

---

## Benchmarks (`tests/performance/`)

Performance baselines are kept under
[`tests/performance/*.bench.test.ts`](../tests/performance/) (the
`.bench` infix excludes them from the default Jest run because Jest's
default `testMatch` requires the file to end in `.test.ts` _without_
extra qualifiers — see `jest.config.cjs` `testMatch`).

Run them opt-in:

```bash
npx jest --testPathPatterns=tests/performance
```

Active benches and their baselines are tabulated in
[`PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md) §5. A
non-exhaustive list:

| File | What it measures |
|------|------------------|
| `jwt-verify.bench.ts` | JWT verify throughput with the active key set. |
| `audit-append.bench.ts` | Hash-chain append latency. |
| `redactor.bench.test.ts` | Sanitiser throughput against 10k rows. |
| `prompt-composer.bench.test.ts` | RAG prompt assembly latency. |
| `policy-engine.bench.test.ts` | Policy evaluation across 10k records. |
| `discovery-snapshot.bench.test.ts` | Snapshot hash latency. |
| `composite-scanner.bench.test.ts` | Fan-out across multiple scanner adapters. |
| `auth-login.bench.test.ts` | End-to-end login path. |
| `metrics-overhead.bench.test.ts` | `prom-client` registry overhead (ADR-0023). |
| `transparency-log.bench.test.ts` | Transparency-log submit. |
| `widget-resolver.bench.test.ts` | Dashboard widget data resolution. |
| `slo-computation.bench.test.ts` | SLO rollup latency. |

There is also `tests/performance/load-test.js` and `stress-test.js` —
those are **k6** scripts, not Jest. Run them with `k6 run`.

---

## Integration suite (`npm run test:integration`)

```bash
npm run test:integration
```

Layout:

- `tests/integration/api.test.ts` — supertest against the assembled
  Express app.
- `tests/auth/*.test.ts` — auth middleware + service contract over a
  real Mongo + Redis.

**State:** the suite currently fails to load on `main` /
`claude/adr-ddd-documentation-uNdZ2` because of legacy refactor
remnants — module-resolution errors against paths that moved during the
bounded-context extraction. Tracked in
[`PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md) §6.7. Do not
mark green until the Testcontainers harness (ADR-0021) lands and the
suite is back to passing.

When running locally, the suite expects:

```bash
docker compose -f docker/docker-compose.yml up -d mongodb redis
export MONGODB_URI=mongodb://localhost:27017/noip-test
export REDIS_HOST=localhost
export REDIS_PORT=6379
```

---

## End-to-end (`npm run test:e2e`)

```bash
npm run test:e2e
# or:
npx playwright test
```

Playwright config: [`playwright.config.ts`](../playwright.config.ts).
Browsers must be installed once with `npx playwright install`. The E2E
happy path (login → run scan → see findings → request AI analysis → see
insight) is tracked under ADR-0021 §6.7 in the readiness checklist.

---

## Architecture tests

Bounded-context isolation (ADR-0010 / ADR-0011 / ADR-0022) is enforced
by `eslint-plugin-import`'s `no-restricted-paths` zones declared in
[`eslint.config.mjs`](../eslint.config.mjs). They run as part of
`npm run lint:check`, so a cross-context model import fails the
`pretest` gate before Jest is invoked. Unit tests for the zones live
under `tests/unit/architecture/`.

---

## Build gates summary

```bash
npm run lint:check    # eslint, 0 errors
npm run typecheck     # tsc --noEmit, 0 errors
npm run build         # tsc emit, exits 0
npm test              # 1025/1025 unit tests, 113 suites
```

`npm run pretest` chains `lint:check`; `npm run prebuild` chains
`lint:check + typecheck`. Both happen automatically when you invoke
the parent scripts.
