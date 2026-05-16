# ADR-0023: Prometheus-based observability

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** SRE, Platform engineering
- **Tags:** observability, ops
- **Implementation:** Complete (2026-05-16) — prom-client registry
  exposed at /metrics; typed counters/histograms in
  `src/observability/metrics.ts`.

## Context and Problem Statement

NOIP needs metrics, logs, and traces to operate reliably. The existing
manifests (`k8s/monitoring/prometheus-deployment.yaml`,
`k8s/monitoring/configmaps.yaml`) commit us to Prometheus.

## Decision Drivers

- Open-source, Kubernetes-native.
- Standard ecosystem (Grafana, Alertmanager).
- Pull-based scraping fits our stateless API.
- Existing in-cluster deployment.

## Considered Options

1. **Prometheus + Grafana + Loki + Tempo** (all open-source, Kubernetes-native).
2. **Datadog / New Relic.**
3. **OpenTelemetry Collector → vendor of choice.**

## Decision Outcome

**Chosen option:** Option 1 with **OpenTelemetry instrumentation in the
application** so we can swap backends without re-instrumenting.

### Metrics

- `prom-client` exposes `/metrics`; default Node + custom counters and
  histograms:
  - `noip_http_requests_total{method,route,status}`
  - `noip_http_request_duration_seconds{route}` (histogram)
  - `noip_auth_login_attempts_total{result}` (success | failure | locked)
  - `noip_mfa_verification_attempts_total{result}`
  - `noip_ai_requests_total{type,result}` and
    `noip_ai_request_tokens_total{type,direction}`
  - `noip_rate_limit_blocks_total{bucket}`
  - `noip_security_findings_total{severity}`
  - `noip_jobs_processed_total{job}` and `_failed_total`
- Histograms use `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`
  buckets.

### Logs

- Structured JSON (Winston) with mandatory fields: `timestamp`, `level`,
  `service`, `requestId`, `userId?`, `event`, `message`, plus context-
  specific fields.
- Logs ship to Loki via Promtail / Vector.

### Traces

- OpenTelemetry SDK with HTTP, Mongoose, Redis instrumentations.
- Sampler: `parentbased(traceidratio=0.1)` in prod, `always_on` in dev.
- Exporter: OTLP → Tempo.

### Alerts

Initial Alertmanager rules:

- `HighErrorRate` — `http_requests_total{status=~"5.."} > 1%` for 5m.
- `HighLatencyP95` — `histogram_quantile(0.95, …) > 500ms` for 10m.
- `RedisDown` — `noip_rate_limit_redis_unavailable_total > 0` for 1m.
- `HighFailedLoginRate` — sustained spike on `noip_auth_login_attempts_total`.
- `AICostBudgetExceeded` — `noip_ai_request_tokens_total` derived $/h above
  budget.

### Positive Consequences

- Standard tooling; broad expertise; existing in-cluster footprint.
- OTel layer keeps optionality.

### Negative Consequences / Trade-offs

- Operating Prometheus, Loki, and Tempo is non-trivial; we use managed Grafana
  Cloud where appropriate.

## References

- `k8s/monitoring/`
- ADR-0014, ADR-0020.
