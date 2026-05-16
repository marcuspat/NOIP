// PerformanceService — application service for the Performance context
// (DDD-09).
//
// Responsibilities:
//   - CRUD on `Probe` and `SLO` aggregates.
//   - Run a probe on demand via `ProbeRunner` and persist the result.
//   - List probe results in a time range.
//   - Submit a load test via `LoadTestRunner`.
//   - Expose `getCurrentSLOStatus()` / `recentLoadTests()` for the
//     public API barrel.
//
// Performance optimisations per DDD-09:
//   - Probe runs are concurrency-capped (`runProbes(ids, concurrency)`).
//   - Probe result writes go through repository `insertMany`.
//   - SLO computation is delegated to `SLOComputer` (batched queries).

import type {
  Clock,
  EventBus,
  LoadTestId,
  ProbeId,
  SLOId,
} from '../../../shared/kernel';
import { NotFoundError } from '../../../shared/errors';
import {
  Probe,
  type ProbeCreateSpec,
  type ProbeUpdateSpec,
} from '../domain/probe';
import { ProbeResult } from '../domain/probe-result';
import type { LoadTest } from '../domain/load-test';
import type { LoadTestSubmitSpec } from '../domain/load-test';
import { SLO, type SLOCreateSpec, type SLOUpdateSpec } from '../domain/slo';
import { ProbeRunner } from '../domain/probe-runner';
import type { ProbeRepository } from '../infrastructure/persistence/probe.repository';
import type {
  ProbeResultListFilter,
  ProbeResultRepository,
} from '../infrastructure/persistence/probe-result.repository';
import type { SLORepository } from '../infrastructure/persistence/slo.repository';
import { SLOComputer } from './slo-computer';
import { LoadTestRunner } from './load-test-runner';
import type { SLOSnapshot } from '../domain/value-objects';

export interface PerformanceServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: PerformanceServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface PerformanceServiceDeps {
  probes: ProbeRepository;
  probeResults: ProbeResultRepository;
  loadTests: {
    listRecent(limit?: number): Promise<LoadTest[]>;
    findById(id: LoadTestId): Promise<LoadTest | null>;
  };
  slos: SLORepository;
  runner: ProbeRunner;
  sloComputer: SLOComputer;
  loadTestRunner: LoadTestRunner;
  bus: EventBus;
  clock: Clock;
  logger?: PerformanceServiceLogger;
  /** Cap on parallel probe runs in `runProbes`. Default 8. */
  probeConcurrency?: number;
}

const DEFAULT_PROBE_CONCURRENCY = 8;

export class PerformanceService {
  private readonly probes: ProbeRepository;
  private readonly probeResults: ProbeResultRepository;
  private readonly loadTests: PerformanceServiceDeps['loadTests'];
  private readonly slos: SLORepository;
  private readonly runner: ProbeRunner;
  private readonly sloComputer: SLOComputer;
  private readonly loadTestRunner: LoadTestRunner;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: PerformanceServiceLogger;
  private readonly probeConcurrency: number;

  constructor(deps: PerformanceServiceDeps) {
    this.probes = deps.probes;
    this.probeResults = deps.probeResults;
    this.loadTests = deps.loadTests;
    this.slos = deps.slos;
    this.runner = deps.runner;
    this.sloComputer = deps.sloComputer;
    this.loadTestRunner = deps.loadTestRunner;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.probeConcurrency = deps.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
  }

  // ---------------------------------------------------------------------------
  // Probe CRUD
  // ---------------------------------------------------------------------------

  async createProbe(spec: ProbeCreateSpec): Promise<Probe> {
    const probe = Probe.create(spec, this.clock);
    await this.probes.save(probe);
    return probe;
  }

  async updateProbe(id: ProbeId, spec: ProbeUpdateSpec): Promise<Probe> {
    const probe = await this.probes.findById(id);
    if (!probe) throw new NotFoundError('Probe', id);
    probe.update(spec, this.clock);
    await this.probes.save(probe);
    return probe;
  }

  async deleteProbe(id: ProbeId): Promise<void> {
    const removed = await this.probes.delete(id);
    if (!removed) throw new NotFoundError('Probe', id);
  }

  async listProbes(limit?: number): Promise<Probe[]> {
    return this.probes.list(limit);
  }

  async getProbe(id: ProbeId): Promise<Probe> {
    const probe = await this.probes.findById(id);
    if (!probe) throw new NotFoundError('Probe', id);
    return probe;
  }

  // ---------------------------------------------------------------------------
  // Probe execution
  // ---------------------------------------------------------------------------

  async runProbeNow(id: ProbeId): Promise<ProbeResult> {
    const probe = await this.getProbe(id);
    const result = await this.runner.run(probe);
    await this.probeResults.save(result);
    const events = result.drainEvents();
    if (events.length > 0) this.bus.publishMany(events);
    return result;
  }

  /**
   * Run a batch of probes with bounded concurrency, then bulk-insert
   * the resulting `ProbeResult`s in a single `insertMany`. Returns the
   * list of recorded results in the same order as `probeIds`.
   */
  async runProbes(probeIds: ReadonlyArray<ProbeId>): Promise<ProbeResult[]> {
    if (probeIds.length === 0) return [];
    const probes: Probe[] = [];
    for (const id of probeIds) {
      const p = await this.probes.findById(id);
      if (p) probes.push(p);
    }
    return this.runMany(probes);
  }

  /** Same as `runProbes` but takes pre-loaded `Probe` aggregates. */
  async runMany(probes: ReadonlyArray<Probe>): Promise<ProbeResult[]> {
    const out: ProbeResult[] = new Array(probes.length);
    let cursor = 0;
    const chunks = chunk(probes.slice(), this.probeConcurrency);
    for (const batch of chunks) {
      const results = await Promise.all(batch.map(p => this.runner.run(p)));
      for (const r of results) {
        out[cursor++] = r;
      }
    }
    // Bulk insert + publish in one round-trip.
    await this.probeResults.saveMany(out);
    for (const r of out) {
      const events = r.drainEvents();
      if (events.length > 0) this.bus.publishMany(events);
    }
    return out;
  }

  async listProbeResults(
    probeId: ProbeId,
    filter: ProbeResultListFilter = {}
  ): Promise<ProbeResult[]> {
    return this.probeResults.listByProbe(probeId, filter);
  }

  // ---------------------------------------------------------------------------
  // Load tests
  // ---------------------------------------------------------------------------

  async submitLoadTest(spec: LoadTestSubmitSpec): Promise<LoadTest> {
    return this.loadTestRunner.run(spec);
  }

  async getLoadTest(id: LoadTestId): Promise<LoadTest> {
    const test = await this.loadTests.findById(id);
    if (!test) throw new NotFoundError('LoadTest', id);
    return test;
  }

  async listLoadTests(limit?: number): Promise<LoadTest[]> {
    return this.loadTests.listRecent(limit);
  }

  // ---------------------------------------------------------------------------
  // SLOs
  // ---------------------------------------------------------------------------

  async defineSLO(spec: SLOCreateSpec): Promise<SLO> {
    const slo = SLO.create(spec, this.clock);
    await this.slos.save(slo);
    return slo;
  }

  async updateSLO(id: SLOId, spec: SLOUpdateSpec): Promise<SLO> {
    const slo = await this.slos.findById(id);
    if (!slo) throw new NotFoundError('SLO', id);
    slo.update(spec, this.clock);
    await this.slos.save(slo);
    return slo;
  }

  async getSLOStatus(id: SLOId): Promise<SLOSnapshot> {
    const slo = await this.slos.findById(id);
    if (!slo) throw new NotFoundError('SLO', id);
    return toSnapshot(slo);
  }

  async listSLOs(): Promise<SLO[]> {
    return this.slos.list();
  }

  async listSLOSnapshots(): Promise<SLOSnapshot[]> {
    const all = await this.slos.list(10_000);
    return all.map(toSnapshot);
  }

  /** Drive one sweep of the SLO computer; useful for the scheduler. */
  async refreshSLOs(): Promise<void> {
    const result = await this.sloComputer.runOnce();
    this.logger.info('SLO sweep complete', {
      updated: result.slosUpdated,
      queries: result.queriesIssued,
      breached: result.breachedCount,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle compat
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<{
    status: string;
    probes: number;
    slos: number;
  }> {
    const [probes, slos] = await Promise.all([
      this.probes.list(1),
      this.slos.list(1),
    ]);
    return {
      status: 'healthy',
      probes: probes.length,
      slos: slos.length,
    };
  }
}

function toSnapshot(slo: SLO): SLOSnapshot {
  return {
    sloId: slo.id,
    name: slo.name,
    target: slo.target,
    window: slo.window,
    currentBurnRate: slo.currentBurnRate,
    remainingBudget: slo.remainingBudget,
    computedAt: slo.updatedAt,
  };
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) return [arr.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}
