// SLOComputer — periodic worker that refreshes `currentBurnRate` and
// `remainingBudget` on every `SLO` aggregate by querying the metric
// store (Prometheus by default). This is the only place where those
// budget fields are mutated; the aggregate enforces that invariant.
//
// Performance optimisation per DDD-09: indicator queries are batched
// into a single `PrometheusClient.queryBatch` call. We collect every
// indicator across every SLO into one flat list, dispatch once, then
// distribute the scalars back to the right aggregates. This collapses
// N×M round-trips (slos × indicators) into a single bounded fan-out.
//
// Budget math: we map the indicator value onto a fraction-of-target
// burn rate using the target kind:
//   - `availability`     burn = (1 - actual) / (1 - target)
//   - `error_rate`       burn = actual / target
//   - `latency_ms`       burn = actual / target
// A burn > 1 means we are consuming budget faster than the SLO
// permits. `remainingBudget` is the saturated `max(0, 1 - burn)`.

import type { Clock, EventBus } from '../../../shared/kernel';
import type {
  PrometheusClient,
  PrometheusInstantQuery,
} from '../domain/ports/prometheus-client';
import { SLO } from '../domain/slo';
import type { SLORepository } from '../infrastructure/persistence/slo.repository';

export interface SLOComputerDeps {
  prom: PrometheusClient;
  slos: SLORepository;
  bus: EventBus;
  clock: Clock;
  /**
   * Optional callback invoked once per SLO with the computed
   * `(burnRate, remainingBudget)` *before* the aggregate is updated.
   * Used by tests and dashboards that want raw observations without
   * subscribing to the bus.
   */
  onObservation?: (slo: SLO, burnRate: number, remainingBudget: number) => void;
}

export interface SLOComputerRunResult {
  slosUpdated: number;
  queriesIssued: number;
  breachedCount: number;
}

export class SLOComputer {
  constructor(private readonly deps: SLOComputerDeps) {}

  /**
   * Run one sweep over `slos`. Pulls them out of the repository if not
   * supplied; flushes everything in a single bulk repository write.
   */
  async runOnce(slos?: ReadonlyArray<SLO>): Promise<SLOComputerRunResult> {
    const list = slos ?? (await this.deps.slos.list(10_000));
    if (list.length === 0) {
      return { slosUpdated: 0, queriesIssued: 0, breachedCount: 0 };
    }

    // Build the flat batch and remember each (sloIdx, indicatorIdx) ->
    // batch position so we can stitch results back together.
    const batch: PrometheusInstantQuery[] = [];
    const offsets: number[] = []; // offsets[i] = batch index where slo i's indicators start
    for (const slo of list) {
      offsets.push(batch.length);
      for (const ind of slo.indicators) {
        batch.push({ query: ind.query });
      }
    }

    const results = await this.deps.prom.queryBatch(batch);

    const touched: SLO[] = [];
    let breachedCount = 0;
    for (let i = 0; i < list.length; i++) {
      const slo = list[i]!;
      const start = offsets[i]!;
      const end = start + slo.indicators.length;
      const slice = results.slice(start, end);
      const obs = aggregateIndicators(slice);
      if (obs === null) continue; // no usable data — skip
      const { burnRate, remainingBudget } = computeBudget(slo, obs);
      this.deps.onObservation?.(slo, burnRate, remainingBudget);
      slo.recordObservation(burnRate, remainingBudget, this.deps.clock);
      const events = slo.drainEvents();
      if (events.length > 0) this.deps.bus.publishMany(events);
      if (slo.breached) breachedCount++;
      touched.push(slo);
    }

    if (touched.length > 0) {
      await this.deps.slos.saveMany(touched);
    }

    return {
      slosUpdated: touched.length,
      queriesIssued: batch.length,
      breachedCount,
    };
  }
}

/**
 * Collapse a list of indicator results to a single scalar by averaging
 * non-null values. Returns `null` if every indicator failed or has no
 * value.
 */
function aggregateIndicators(
  results: ReadonlyArray<{ value: number | null }>
): number | null {
  let sum = 0;
  let count = 0;
  for (const r of results) {
    if (r.value === null) continue;
    if (!Number.isFinite(r.value)) continue;
    sum += r.value;
    count++;
  }
  return count === 0 ? null : sum / count;
}

/**
 * Map an observation onto `(burnRate, remainingBudget)`. The formula
 * depends on the target kind.
 */
function computeBudget(
  slo: SLO,
  observation: number
): { burnRate: number; remainingBudget: number } {
  let burn: number;
  switch (slo.target.kind) {
    case 'availability': {
      // `observation` is the observed success ratio in [0, 1].
      const allowedBudget = 1 - slo.target.value;
      if (allowedBudget <= 0) {
        burn = observation >= 1 ? 0 : Number.POSITIVE_INFINITY;
      } else {
        burn = (1 - observation) / allowedBudget;
      }
      break;
    }
    case 'error_rate': {
      // Lower is better; burn = observed / target.
      burn =
        slo.target.value === 0
          ? observation > 0
            ? Number.POSITIVE_INFINITY
            : 0
          : observation / slo.target.value;
      break;
    }
    case 'latency_ms': {
      burn =
        slo.target.value === 0
          ? observation > 0
            ? Number.POSITIVE_INFINITY
            : 0
          : observation / slo.target.value;
      break;
    }
  }
  if (!Number.isFinite(burn) || burn < 0) burn = burn < 0 ? 0 : 1e9;
  const remaining = Math.max(0, Math.min(1, 1 - burn));
  return { burnRate: burn, remainingBudget: remaining };
}
