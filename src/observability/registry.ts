// Prometheus metric registry — ADR-0023 Phase 5 implementation.
//
// One shared `prom-client` Registry per pod. All typed metrics in
// `metrics.ts` register themselves here on first import; the metrics
// endpoint (`metrics-endpoint.ts`) serialises this registry.
//
// Design notes:
//   * Idempotent constructors. Calling `counter('foo', ...)` twice
//     returns the same instance — handy in tests that re-import
//     modules and avoids prom-client's "already registered" throw.
//   * Default labels (`service`, `env`, `version`) are applied here so
//     every metric carries them without per-call boilerplate.
//   * Histograms default to the ADR-0023 bucket list. Buckets in
//     seconds; observe latency via `.observe(seconds)`.

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';

import { config } from '../config';

/**
 * Default histogram buckets from ADR-0023 (seconds). Use for HTTP /
 * outbound RPC latency unless you have evidence a different shape
 * fits better.
 */
export const DEFAULT_HISTOGRAM_BUCKETS: ReadonlyArray<number> = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

/** Shared registry — exported for the metrics endpoint and tests. */
export const register: Registry = new Registry();

register.setDefaultLabels({
  service: 'noip',
  env: config.app.environment,
  version: config.app.version,
});

let defaultMetricsCollected = false;

/**
 * Enable prom-client's default Node.js process metrics (CPU, memory,
 * GC, event-loop lag). Idempotent. Called from the composition root
 * once `register` has been mounted.
 */
export function collectNodeDefaultMetrics(): void {
  if (defaultMetricsCollected) return;
  defaultMetricsCollected = true;
  collectDefaultMetrics({ register });
}

/**
 * Test helper. Wipes every registered metric and forgets the
 * default-metrics flag so the next `collectNodeDefaultMetrics()` call
 * re-attaches. Useful in `beforeEach()` to keep counter values
 * independent across tests.
 */
export function resetRegistryForTests(): void {
  register.clear();
  register.setDefaultLabels({
    service: 'noip',
    env: config.app.environment,
    version: config.app.version,
  });
  defaultMetricsCollected = false;
}

/**
 * Idempotent counter constructor. Returns the existing metric when a
 * counter with `name` is already registered, otherwise creates a new
 * one against the shared `register`.
 *
 * The label-name tuple is captured as a const generic so call sites
 * get autocomplete on `.labels({ ... })`.
 */
export function counter<L extends string>(
  name: string,
  help: string,
  labelNames: ReadonlyArray<L> = [] as unknown as ReadonlyArray<L>
): Counter<L> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Counter<L>;
  }
  const cfg: CounterConfiguration<L> = {
    name,
    help,
    labelNames: [...labelNames] as L[],
    registers: [register],
  };
  return new Counter<L>(cfg);
}

/** Idempotent gauge constructor. See `counter` for semantics. */
export function gauge<L extends string>(
  name: string,
  help: string,
  labelNames: ReadonlyArray<L> = [] as unknown as ReadonlyArray<L>
): Gauge<L> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Gauge<L>;
  }
  const cfg: GaugeConfiguration<L> = {
    name,
    help,
    labelNames: [...labelNames] as L[],
    registers: [register],
  };
  return new Gauge<L>(cfg);
}

/**
 * Idempotent histogram constructor. Defaults to
 * `DEFAULT_HISTOGRAM_BUCKETS` — pass an explicit `buckets` array only
 * when measuring something that isn't seconds-of-latency.
 */
export function histogram<L extends string>(
  name: string,
  help: string,
  labelNames: ReadonlyArray<L> = [] as unknown as ReadonlyArray<L>,
  buckets: ReadonlyArray<number> = DEFAULT_HISTOGRAM_BUCKETS
): Histogram<L> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Histogram<L>;
  }
  const cfg: HistogramConfiguration<L> = {
    name,
    help,
    labelNames: [...labelNames] as L[],
    buckets: [...buckets],
    registers: [register],
  };
  return new Histogram<L>(cfg);
}
