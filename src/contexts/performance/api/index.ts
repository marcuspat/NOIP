// Public API barrel for the Performance context.
// Per ADR-0011 cross-context callers MUST only import from this module.
//
// What we expose:
//   - The `PerformancePublicApi` interface (DDD-09).
//   - Aggregate types and value objects (as `import type`) needed by
//     downstream contexts (Dashboard, AI).
//   - The `composePerformance` factory that wires everything for the
//     composition root and tests.
//   - The HTTP router factory.

import type { Router } from 'express';
import type { Clock, EventBus } from '../../../shared/kernel';
import { PerformanceService } from '../application/performance.service';
import { SLOComputer } from '../application/slo-computer';
import { LoadTestRunner } from '../application/load-test-runner';
import { ProbeRunner } from '../domain/probe-runner';
import {
  MongooseProbeRepository,
  type ProbeRepository,
} from '../infrastructure/persistence/probe.repository';
import {
  MongooseProbeResultRepository,
  type ProbeResultRepository,
} from '../infrastructure/persistence/probe-result.repository';
import {
  MongooseLoadTestRepository,
  type LoadTestRepository,
} from '../infrastructure/persistence/load-test.repository';
import {
  MongooseSLORepository,
  type SLORepository,
} from '../infrastructure/persistence/slo.repository';
import { HttpProbeAdapter } from '../infrastructure/http-probe/http-probe-adapter';
import { AutocannonAdapter } from '../infrastructure/load-test/autocannon-adapter';
import { K6Adapter } from '../infrastructure/load-test/k6-adapter';
import { InMemoryPromStub } from '../infrastructure/prometheus/in-memory-prom-stub';
import type { HttpProbeClient } from '../domain/ports/http-probe-client';
import type { LoadTestEngine } from '../domain/ports/load-test-engine';
import type { PrometheusClient } from '../domain/ports/prometheus-client';
import type { LoadTest } from '../domain/load-test';
import type { ProbeResult } from '../domain/probe-result';
import type { SLOSnapshot } from '../domain/value-objects';
import performanceRoutes from '../http/routes';

// ---------------------------------------------------------------------------
// Re-exports (public domain types)
// ---------------------------------------------------------------------------
export { Probe } from '../domain/probe';
export type {
  ProbePersistence,
  ProbeCreateSpec,
  ProbeUpdateSpec,
} from '../domain/probe';
export { ProbeResult } from '../domain/probe-result';
export type { ProbeResultPersistence, ResultId } from '../domain/probe-result';
export { LoadTest } from '../domain/load-test';
export type {
  LoadTestPersistence,
  LoadTestSubmitSpec,
} from '../domain/load-test';
export { SLO } from '../domain/slo';
export type {
  SLOPersistence,
  SLOCreateSpec,
  SLOUpdateSpec,
} from '../domain/slo';
export type {
  Indicator,
  HttpProbeConfig,
  LoadTestError,
  LoadTestStatus,
  LoadTestSummary,
  ProbeConfig,
  ProbeKind,
  ProbeMeasurements,
  Profile,
  SLOSnapshot,
  SLOTarget,
  Schedule,
  Window,
} from '../domain/value-objects';
export { emptyLoadTestSummary } from '../domain/value-objects';

export { ProbeRunner } from '../domain/probe-runner';
export { PerformanceService } from '../application/performance.service';
export { SLOComputer } from '../application/slo-computer';
export { LoadTestRunner } from '../application/load-test-runner';

export { HttpProbeAdapter } from '../infrastructure/http-probe/http-probe-adapter';
export { AutocannonAdapter } from '../infrastructure/load-test/autocannon-adapter';
export { K6Adapter } from '../infrastructure/load-test/k6-adapter';
export { PrometheusAdapter } from '../infrastructure/prometheus/prometheus-adapter';
export { InMemoryPromStub } from '../infrastructure/prometheus/in-memory-prom-stub';

export type {
  HttpProbeClient,
  HttpProbeRequest,
  HttpProbeResponse,
} from '../domain/ports/http-probe-client';
export type {
  LoadTestEngine,
  LoadTestRunRequest,
} from '../domain/ports/load-test-engine';
export type {
  PrometheusClient,
  PrometheusBatchResult,
  PrometheusInstantQuery,
} from '../domain/ports/prometheus-client';

export {
  MongooseProbeRepository,
  InMemoryProbeRepository,
} from '../infrastructure/persistence/probe.repository';
export type { ProbeRepository } from '../infrastructure/persistence/probe.repository';
export {
  MongooseProbeResultRepository,
  InMemoryProbeResultRepository,
} from '../infrastructure/persistence/probe-result.repository';
export type {
  ProbeResultRepository,
  ProbeResultListFilter,
} from '../infrastructure/persistence/probe-result.repository';
export {
  MongooseLoadTestRepository,
  InMemoryLoadTestRepository,
} from '../infrastructure/persistence/load-test.repository';
export type { LoadTestRepository } from '../infrastructure/persistence/load-test.repository';
export {
  MongooseSLORepository,
  InMemorySLORepository,
} from '../infrastructure/persistence/slo.repository';
export type { SLORepository } from '../infrastructure/persistence/slo.repository';

export { performanceRoutes };

// ---------------------------------------------------------------------------
// Public API contract per DDD-09
// ---------------------------------------------------------------------------

export interface PerformancePublicApi {
  getCurrentSLOStatus(): Promise<SLOSnapshot[]>;
  runProbe(probeIdOrTarget: string): Promise<ProbeResult>;
  recentLoadTests(limit?: number): Promise<LoadTest[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposePerformanceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ComposePerformanceDeps {
  bus: EventBus;
  clock: Clock;
  logger: ComposePerformanceLogger;
  /** Optional repository overrides for tests / alt persistence. */
  repos?: {
    probes?: ProbeRepository;
    probeResults?: ProbeResultRepository;
    loadTests?: LoadTestRepository;
    slos?: SLORepository;
  };
  /** Override the HTTP probe client; defaults to native fetch. */
  httpProbe?: HttpProbeClient;
  /** Override load-test engines; defaults to autocannon + k6 (stub fallbacks). */
  loadTestEngines?: ReadonlyArray<LoadTestEngine>;
  /**
   * Override the Prometheus client; defaults to `InMemoryPromStub` so
   * the SLOComputer is callable even when Prometheus is not wired.
   */
  prometheus?: PrometheusClient;
  /** Concurrency cap on parallel probe runs. */
  probeConcurrency?: number;
}

export interface ComposedPerformance {
  service: PerformanceService;
  sloComputer: SLOComputer;
  loadTestRunner: LoadTestRunner;
  probeRunner: ProbeRunner;
  publicApi: PerformancePublicApi;
  router: Router;
}

export function composePerformance(
  deps: ComposePerformanceDeps
): ComposedPerformance {
  const probes = deps.repos?.probes ?? new MongooseProbeRepository();
  const probeResults =
    deps.repos?.probeResults ?? new MongooseProbeResultRepository();
  const loadTests = deps.repos?.loadTests ?? new MongooseLoadTestRepository();
  const slos = deps.repos?.slos ?? new MongooseSLORepository();

  const httpProbe = deps.httpProbe ?? new HttpProbeAdapter();
  const engines = deps.loadTestEngines ?? [
    new AutocannonAdapter(),
    new K6Adapter(),
  ];
  const prom = deps.prometheus ?? new InMemoryPromStub();

  const probeRunner = new ProbeRunner({ http: httpProbe, clock: deps.clock });
  const sloComputer = new SLOComputer({
    prom,
    slos,
    bus: deps.bus,
    clock: deps.clock,
  });
  const loadTestRunner = new LoadTestRunner({
    engines,
    loadTests,
    bus: deps.bus,
    clock: deps.clock,
  });

  const service = new PerformanceService({
    probes,
    probeResults,
    loadTests,
    slos,
    runner: probeRunner,
    sloComputer,
    loadTestRunner,
    bus: deps.bus,
    clock: deps.clock,
    logger: deps.logger,
    ...(deps.probeConcurrency !== undefined
      ? { probeConcurrency: deps.probeConcurrency }
      : {}),
  });

  const publicApi: PerformancePublicApi = {
    getCurrentSLOStatus: () => service.listSLOSnapshots(),
    runProbe: id =>
      service.runProbeNow(id as Parameters<typeof service.runProbeNow>[0]),
    recentLoadTests: limit => service.listLoadTests(limit),
  };

  return {
    service,
    sloComputer,
    loadTestRunner,
    probeRunner,
    publicApi,
    router: performanceRoutes(service),
  };
}
