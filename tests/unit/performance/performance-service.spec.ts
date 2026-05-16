// PerformanceService — application-layer tests covering Probe CRUD,
// concurrency-capped fan-out, bulk insertMany, and SLO/load-test wiring.

import { composePerformance } from '../../../src/contexts/performance/api';
import { InMemoryProbeRepository } from '../../../src/contexts/performance/infrastructure/persistence/probe.repository';
import { InMemoryProbeResultRepository } from '../../../src/contexts/performance/infrastructure/persistence/probe-result.repository';
import { InMemoryLoadTestRepository } from '../../../src/contexts/performance/infrastructure/persistence/load-test.repository';
import { InMemorySLORepository } from '../../../src/contexts/performance/infrastructure/persistence/slo.repository';
import { InMemoryPromStub } from '../../../src/contexts/performance/infrastructure/prometheus/in-memory-prom-stub';
import type { LoadTestEngine } from '../../../src/contexts/performance/domain/ports/load-test-engine';
import type { HttpProbeClient } from '../../../src/contexts/performance/domain/ports/http-probe-client';
import { emptyLoadTestSummary } from '../../../src/contexts/performance/domain/value-objects';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type DomainEvent,
  type ProbeId,
} from '../../../src/shared/kernel';
import { NotFoundError, ValidationError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function build(
  opts: {
    http?: HttpProbeClient;
    engines?: LoadTestEngine[];
  } = {}
) {
  const probes = new InMemoryProbeRepository();
  const probeResults = new InMemoryProbeResultRepository();
  const loadTests = new InMemoryLoadTestRepository();
  const slos = new InMemorySLORepository();
  const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
  const events: DomainEvent[] = [];
  bus.subscribe('performance.*', e => events.push(e));
  const composed = composePerformance({
    bus,
    clock,
    logger,
    repos: { probes, probeResults, loadTests, slos },
    httpProbe: opts.http ?? {
      execute: async () => ({
        latencyMs: 1,
        success: true,
        measurements: { statusCode: 200 },
      }),
    },
    loadTestEngines: opts.engines ?? [
      {
        id: 'stub',
        run: async () => ({
          ...emptyLoadTestSummary(),
          totalRequests: 10,
          rps: 1,
        }),
      },
    ],
    prometheus: new InMemoryPromStub(),
    probeConcurrency: 2,
  });
  return { composed, probes, probeResults, slos, bus, events };
}

describe('PerformanceService', () => {
  it('createProbe persists + listProbes returns it', async () => {
    const { composed } = build();
    const probe = await composed.service.createProbe({
      name: 'p',
      kind: 'http',
      target: 'http://t',
      schedule: { intervalMs: 1000 },
    });
    const list = await composed.service.listProbes();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(probe.id);
  });

  it('updateProbe throws NotFoundError on unknown id', async () => {
    const { composed } = build();
    await expect(
      composed.service.updateProbe(newId<ProbeId>(), { name: 'x' })
    ).rejects.toThrow(NotFoundError);
  });

  it('deleteProbe throws NotFoundError on unknown id', async () => {
    const { composed } = build();
    await expect(
      composed.service.deleteProbe(newId<ProbeId>())
    ).rejects.toThrow(NotFoundError);
  });

  it('runProbeNow stores the result + publishes events for failures', async () => {
    const { composed, probeResults, events } = build({
      http: {
        execute: async () => ({
          latencyMs: 1,
          success: false,
          failureReason: 'HTTP 500',
          measurements: {},
        }),
      },
    });
    const probe = await composed.service.createProbe({
      name: 'p',
      kind: 'http',
      target: 'http://t',
      schedule: { intervalMs: 1000 },
    });
    await composed.service.runProbeNow(probe.id);
    expect(probeResults.size()).toBe(1);
    expect(events.some(e => e.type === 'performance.probe.failed')).toBe(true);
  });

  it('runProbes bulk-inserts via saveMany and caps concurrency', async () => {
    let inflight = 0;
    let peak = 0;
    const http: HttpProbeClient = {
      execute: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise(r => setImmediate(r));
        inflight--;
        return { latencyMs: 1, success: true, measurements: {} };
      },
    };
    const { composed, probeResults } = build({ http });
    const spy = jest.spyOn(probeResults, 'saveMany');
    const probes = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        composed.service.createProbe({
          name: `p${i}`,
          kind: 'http',
          target: 'http://t',
          schedule: { intervalMs: 1000 },
        })
      )
    );
    await composed.service.runProbes(probes.map(p => p.id));
    expect(spy).toHaveBeenCalledTimes(1);
    // probeConcurrency was set to 2 in build().
    expect(peak).toBeLessThanOrEqual(2);
    expect(probeResults.size()).toBe(5);
  });

  it('defineSLO + getSLOStatus round-trip', async () => {
    const { composed } = build();
    const slo = await composed.service.defineSLO({
      name: 'avail',
      target: { kind: 'availability', value: 0.999 },
      window: { rollingDays: 28 },
      indicators: [{ query: 'q' }],
    });
    const snapshot = await composed.service.getSLOStatus(slo.id);
    expect(snapshot.sloId).toBe(slo.id);
    expect(snapshot.remainingBudget).toBe(1);
  });

  it('submitLoadTest dispatches to the named engine and persists', async () => {
    let engineCalled = false;
    const { composed } = build({
      engines: [
        {
          id: 'special',
          run: async () => {
            engineCalled = true;
            return {
              ...emptyLoadTestSummary(),
              totalRequests: 1,
              rps: 1,
            };
          },
        },
      ],
    });
    const t = await composed.service.submitLoadTest({
      name: 'x',
      script: '',
      target: 'http://t',
      engine: 'special',
      profile: { rps: 1, vus: 1, durationSec: 1 },
    });
    expect(engineCalled).toBe(true);
    expect(t.status).toBe('succeeded');
  });

  it('submitLoadTest fails the aggregate when the engine throws', async () => {
    const { composed, events } = build({
      engines: [
        {
          id: 'broken',
          run: async () => {
            throw new ValidationError('bad script');
          },
        },
      ],
    });
    const t = await composed.service.submitLoadTest({
      name: 'x',
      script: '',
      target: 'http://t',
      engine: 'broken',
      profile: { rps: 1, vus: 1, durationSec: 1 },
    });
    expect(t.status).toBe('failed');
    expect(t.error?.code).toBe('VALIDATION_ERROR');
    expect(
      events.find(e => e.type === 'performance.load_test.completed')
    ).toBeUndefined();
  });

  it('healthCheck reports counts', async () => {
    const { composed } = build();
    await composed.service.createProbe({
      name: 'p',
      kind: 'http',
      target: 't',
      schedule: { intervalMs: 1 },
    });
    const h = await composed.service.healthCheck();
    expect(h.status).toBe('healthy');
    expect(h.probes).toBe(1);
  });

  it('publicApi.runProbe → runProbeNow', async () => {
    const { composed } = build();
    const p = await composed.service.createProbe({
      name: 'p',
      kind: 'http',
      target: 't',
      schedule: { intervalMs: 1 },
    });
    const r = await composed.publicApi.runProbe(p.id);
    expect(r.probeId).toBe(p.id);
  });

  it('publicApi.recentLoadTests returns persisted tests', async () => {
    const { composed } = build();
    await composed.service.submitLoadTest({
      name: 'x',
      script: '',
      target: 't',
      engine: 'stub',
      profile: { rps: 1, vus: 1, durationSec: 1 },
    });
    const recent = await composed.publicApi.recentLoadTests();
    expect(recent).toHaveLength(1);
  });
});
