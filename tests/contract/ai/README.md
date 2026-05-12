# AI context — contract tests

This directory contains **live contract tests** for the AI context's
infrastructure adapters. Unlike unit tests, they require a real
external service to talk to. They are **skip-gated**: when the target
service is unreachable, every test logs a SKIP line and returns
without failing.

## What's here

| File | Purpose |
|------|---------|
| `chroma-adapter.contract.spec.ts` | End-to-end exercise of `ChromaAdapter` against a real ChromaDB instance. |
| `_helpers/chroma-availability.ts` | Heartbeat probe with `AbortController` timeout. Never throws. |
| `_helpers/synthetic-corpus.ts` | Deterministic 30-doc / 3-topic corpus, plus large-payload and concurrent-batch generators. |
| `_helpers/collection-lifecycle.ts` | Create / drop helpers used per run to keep collections isolated. |

## Running

The contract suite is **NOT** part of `npm test` (which targets unit
tests only). Invoke it explicitly:

```bash
# Local dev: spin up Chroma in Docker, then run the suite.
docker run -d --name chroma -p 8000:8000 chromadb/chroma:latest
CHROMA_URL=http://localhost:8000 npm run test:contract
```

```bash
# Nightly CI:
#   - CHROMA_URL points to the shared nightly Chroma instance.
#   - CHROMA_CONTRACT_VERBOSE=1 dumps per-test timing and a histogram
#     of HTTP status codes (useful when upstream Chroma drifts).
CHROMA_URL=http://chroma.nightly.svc:8000 \
CHROMA_CONTRACT_VERBOSE=1 \
npm run test:contract
```

If `CHROMA_URL` is missing or the heartbeat fails inside the 1.5s
timeout, the suite prints one line:

```
[chroma-contract] CHROMA_URL=<url> reachable=false
```

…and every test logs a SKIP. The job still exits 0.

## Collection isolation

Each run mints a unique collection name of the form
`noip_contract_<unix-ms>_<4hex>`. `afterAll` best-effort drops it. A
failed delete is logged as a warning, never a test failure.

## Adding more contract tests

1. Drop a file matching `*.contract.spec.ts` into this directory.
2. Use the `isChromaReachable` helper (or a service-specific
   equivalent) in `beforeAll`.
3. Gate each `it()` so it returns early when the service is
   unreachable. Don't `throw` in the gate.
4. Keep the suite resilient to upstream regressions: prefer
   `expect(x).toBeGreaterThanOrEqual(N)` over exact equality when
   N depends on the upstream's embedding/ranking behaviour.

## See also

- `docs/architecture/adr/0013-rag-knowledge-base-chromadb.md`
- `src/contexts/ai/infrastructure/chroma/chroma-adapter.ts`
- `tests/unit/contract-harness/` — unit tests for the helpers above.
