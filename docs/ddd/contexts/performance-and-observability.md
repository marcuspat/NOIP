# Bounded Context: Performance & Observability

> *Supporting subdomain.* NOIP must be observable to its operators; an
> "infrastructure intelligence platform" that cannot tell you about
> *itself* is a hard sell.

## Purpose

Run synthetic load tests against NOIP, collect metrics about NOIP's
own runtime behaviour, surface SLO/threshold breaches, and feed
performance data to dashboards and (when relevant) to Security
Operations.

## Ubiquitous language (canonical)

`Load Test` · `Metric` · `Performance Report`. See
[`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern         | File                                          |
| --------------- | --------------------------------------------- |
| Domain service  | `src/services/performance.service.ts`         |
| HTTP controller | `src/controllers/performance.controller.ts`   |
| HTTP routes     | `src/routes/performance.routes.ts`            |

Aggregate models for `LoadTest`, `MetricSeries`, `PerformanceReport`
are **planned**; today's service computes results from in-memory
fixtures and Prometheus scrapes. Shapes below are the contract.

## Aggregates

### LoadTest
- **Root**: `LoadTest`.
- **Identity**: `LoadTestId`.
- **Fields**: `name`, `kind: smoke | baseline | stress | soak`,
  `targetEndpoint`, `concurrency`, `duration`, `startedAt`,
  `completedAt?`, `status: queued | running | completed | failed`.
- **Embedded results** (set on completion):
  - `throughput` — requests / second.
  - `latency` — `{ p50, p90, p95, p99 }` in milliseconds.
  - `errorRate` — fraction of non-2xx.
  - `resourceUsage` — CPU/RAM peak/avg samples.
- **Invariants**:
  1. Once `status` is `completed` or `failed`, the aggregate is
     immutable.
  2. `targetEndpoint` is internal — load tests cannot point at
     third-party APIs.

### MetricSeries
- **Root**: `MetricSeries`.
- **Identity**: `(metricName, dimensionsHash, bucketStartAt)`.
- **Fields**: bucketed counters/gauges over a fixed window.
- **Invariants**:
  1. Bucket bounds are append-only; existing buckets never mutate.
  2. Cardinality of dimensions is bounded by an allow-list.

### PerformanceReport
- **Root**: `PerformanceReport`.
- **Identity**: `ReportId`.
- **References**: `loadTestIds[]`, `windowStart`, `windowEnd`.
- **Fields**: aggregated metrics, SLO compliance summary, narrative.
- **Invariants**:
  1. Immutable after generation.
  2. Window must be closed (`windowEnd <= now`).

## Value objects

- `LatencyDistribution` — `{ p50, p90, p95, p99, max }`.
- `Throughput` — `requestsPerSecond` plus a confidence band.
- `SLO` — `{ name, objective, window }` (e.g. "99% of requests
  under 250ms over rolling 30 days").

## Domain service

`PerformanceService`:

- `scheduleLoadTest(input)` → `LoadTest` (status `queued`).
- `runLoadTest(loadTestId)` — internal worker, transitions to
  `running`, executes, transitions to `completed | failed`, emits
  `perf.LoadTestCompleted`.
- `cancelLoadTest(loadTestId)`.
- `getMetrics(filter, window)` — bucketed series.
- `getSummary(window)` — across-the-board health snapshot.
- `evaluateSLOs(window)` — returns per-SLO `pass | breach` and
  emits `perf.ThresholdBreached` on transitions to breach.

## Sources of metrics

- NOIP exposes `/metrics` in Prometheus format (default port 9090,
  configurable). Helper instrumentation lives in
  `src/utils/metrics.ts` (planned) and is registered from each
  service.
- `Performance & Observability` *consumes* these via a Prometheus
  client; it does not own the gauge/counter definitions, which live
  with the emitting service.
- External cluster signals (Pod CPU, memory, restarts) are read by
  the operator's existing Prometheus stack — NOIP does not duplicate
  this collection.

## Domain events

`perf.LoadTestCompleted`, `perf.ThresholdBreached`. See
[`../domain-events.md`](../domain-events.md).

## Integration with neighbouring contexts

- **Dashboard**: consumes performance reports and live metrics for
  visualisation.
- **Security Operations**: subscribes to `perf.ThresholdBreached`
  *only when the breach is security-relevant* (e.g. a sustained
  abnormal request rate may indicate an attack).
- **Audit**: every load test start/stop is an `AuditEvent` (operator
  action with a target).

## Failure modes

- **Prometheus unreachable**: live-metric panels show "unavailable";
  load tests can still run (they record their own results).
- **Load test target itself down**: the test reports `failed` with an
  error class; the platform does not retry automatically.

## Out of scope (deliberately)

- **Tracing** (OpenTelemetry distributed traces). On the roadmap;
  today we have correlation ids in logs only.
- **APM-grade profiling**. NOIP does not pretend to be Datadog APM.
- **Customer infrastructure perf testing.** Load tests target NOIP
  itself; testing a customer's clusters is a separate, careful
  capability that does not exist today.

## Open questions

- Whether to bound load-test concurrency administratively to prevent
  an operator from accidentally DoSing a small environment.
- Long-term metric retention strategy — today: TTL-based; future:
  downsampled rollups.
