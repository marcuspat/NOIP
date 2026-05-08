# ADR-0015: Structured logging with Winston + correlation IDs

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** observability, logging

## Context

NOIP's logs are consumed by humans during incidents and by log-
aggregation tooling (Loki/Elastic) for alerting and forensics. They
must:

1. Be machine-parseable (JSON).
2. Include enough context (correlation id, user id, session id,
   route, latency) to reconstruct any single request.
3. Not leak secrets or personally identifiable information beyond
   what's necessary.
4. Be cheap on the hot path.

## Decision

We use **Winston** (`winston ^3.18`) configured in
`src/utils/logger.ts` with:

- `format.json()` in production, `format.simple()` in dev.
- A `combine` pipeline that adds `timestamp`, `service`, `env`,
  `version`, and a `correlationId` resolved from
  `AsyncLocalStorage`.
- Levels: `error | warn | info | http | debug`. Default `info` in
  production, `debug` in dev.
- `morgan` is wired into the same Winston instance for HTTP access
  logs.

Every incoming HTTP request gets a UUIDv7 correlation id (read from
the `X-Correlation-Id` header if present, otherwise generated). The id
is set in `AsyncLocalStorage` so any nested log call inherits it. The
id is also written to the response header for client-side tracing.

Sensitive fields are redacted by a `redact()` helper that knows about
common secret-shaped keys (`password`, `token`, `authorization`,
`mfaSecret`, `backupCodes`, …). Models override `toJSON` to strip the
same fields when serialised over HTTP.

## Alternatives considered

- **`console.log`.** Unstructured, no levels, no rotation, no
  correlation — non-starter.
- **Pino.** Faster JSON serialisation. Considered; Winston is already
  in place and the latency difference is not on the critical path.
- **OpenTelemetry traces only.** Traces are great but not a
  replacement for narrative logs during incidents.

## Consequences

### Positive
- Single command to find every log line in a request:
  `grep <correlationId>`.
- Logs ship to any structured backend without transformation.
- Redaction is centralised and testable.

### Negative / costs
- Winston's plugin API has some quirks; we don't use exotic
  transports.
- AsyncLocalStorage adds a small overhead on every async hop —
  measured negligible.

### Risks and mitigations
- *Forgotten redaction.* Unit tests assert that `password`,
  `mfaSecret`, etc. never appear in serialised output. CI fails on
  regression.

## References

- `src/utils/logger.ts`
- `src/middleware/audit.middleware.ts` — populates the correlation
  ALS context.
