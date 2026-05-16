// SLOComputer — batches indicator queries, flips breach state, emits
// the right events.

import { SLO } from '../../../src/contexts/performance/domain/slo';
import { SLOComputer } from '../../../src/contexts/performance/application/slo-computer';
import { InMemoryPromStub } from '../../../src/contexts/performance/infrastructure/prometheus/in-memory-prom-stub';
import { InMemorySLORepository } from '../../../src/contexts/performance/infrastructure/persistence/slo.repository';
import {
  FixedClock,
  InMemoryEventBus,
  type DomainEvent,
} from '../../../src/shared/kernel';

describe('SLOComputer', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function makeAvailabilitySLO(name = 'avail') {
    return SLO.create(
      {
        name,
        target: { kind: 'availability', value: 0.999 },
        window: { rollingDays: 28 },
        indicators: [{ query: `success_ratio{name="${name}"}` }],
      },
      clock
    );
  }

  function makeLatencySLO(name = 'latency') {
    return SLO.create(
      {
        name,
        target: { kind: 'latency_ms', value: 200 },
        window: { rollingDays: 28 },
        indicators: [{ query: `p95{name="${name}"}` }],
      },
      clock
    );
  }

  it('issues one batched query per indicator across all SLOs', async () => {
    const repo = new InMemorySLORepository();
    const a = makeAvailabilitySLO('a');
    const b = makeAvailabilitySLO('b');
    await repo.saveMany([a, b]);
    const prom = new InMemoryPromStub();
    prom.set('success_ratio{name="a"}', 1);
    prom.set('success_ratio{name="b"}', 1);
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    const computer = new SLOComputer({ prom, slos: repo, bus, clock });
    const result = await computer.runOnce();
    expect(result.queriesIssued).toBe(2);
    expect(result.slosUpdated).toBe(2);
  });

  it('flips to breached and emits performance.slo.breached', async () => {
    const repo = new InMemorySLORepository();
    const slo = makeAvailabilitySLO('a');
    await repo.save(slo);
    const prom = new InMemoryPromStub();
    // 99% observed vs target 99.9% → burn ≈ 10 → breached.
    prom.set('success_ratio{name="a"}', 0.99);
    const events: DomainEvent[] = [];
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    bus.subscribe('performance.*', e => {
      events.push(e);
    });
    const computer = new SLOComputer({ prom, slos: repo, bus, clock });
    await computer.runOnce();
    expect(events.some(e => e.type === 'performance.slo.breached')).toBe(true);
    const reloaded = await repo.findById(slo.id);
    expect(reloaded?.breached).toBe(true);
  });

  it('flips back to recovered and emits performance.slo.recovered', async () => {
    const repo = new InMemorySLORepository();
    const slo = makeAvailabilitySLO('a');
    await repo.save(slo);
    const prom = new InMemoryPromStub();
    prom.set('success_ratio{name="a"}', 0.9); // breach
    const events: DomainEvent[] = [];
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    bus.subscribe('performance.*', e => {
      events.push(e);
    });
    const computer = new SLOComputer({ prom, slos: repo, bus, clock });
    await computer.runOnce();
    // Now recovery — 100% success.
    prom.set('success_ratio{name="a"}', 1);
    events.length = 0;
    await computer.runOnce();
    expect(events.some(e => e.type === 'performance.slo.recovered')).toBe(true);
  });

  it('latency target burn = observed / target', async () => {
    const repo = new InMemorySLORepository();
    const slo = makeLatencySLO('a');
    await repo.save(slo);
    const prom = new InMemoryPromStub();
    prom.set('p95{name="a"}', 400); // 400 / 200 = 2 burn
    const observed: Array<{ burn: number; budget: number }> = [];
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    const computer = new SLOComputer({
      prom,
      slos: repo,
      bus,
      clock,
      onObservation: (_, burn, budget) => observed.push({ burn, budget }),
    });
    await computer.runOnce();
    expect(observed[0]?.burn).toBeCloseTo(2);
    expect(observed[0]?.budget).toBe(0);
  });

  it('skips SLOs whose indicators all return null', async () => {
    const repo = new InMemorySLORepository();
    const slo = makeAvailabilitySLO('a');
    await repo.save(slo);
    const prom = new InMemoryPromStub(); // no values seeded → all null
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    const computer = new SLOComputer({ prom, slos: repo, bus, clock });
    const result = await computer.runOnce();
    expect(result.slosUpdated).toBe(0);
  });

  it('aggregates multiple indicators by mean', async () => {
    const repo = new InMemorySLORepository();
    const slo = SLO.create(
      {
        name: 'multi',
        target: { kind: 'latency_ms', value: 100 },
        window: { rollingDays: 28 },
        indicators: [{ query: 'a' }, { query: 'b' }, { query: 'c' }],
      },
      clock
    );
    await repo.save(slo);
    const prom = new InMemoryPromStub();
    prom.set('a', 60);
    prom.set('b', 80);
    prom.set('c', 100); // mean = 80 → burn = 0.8, not breached
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    const observed: number[] = [];
    const computer = new SLOComputer({
      prom,
      slos: repo,
      bus,
      clock,
      onObservation: (_, burn) => observed.push(burn),
    });
    await computer.runOnce();
    expect(observed[0]).toBeCloseTo(0.8);
  });

  it('persists touched SLOs via repository.saveMany', async () => {
    const repo = new InMemorySLORepository();
    const spy = jest.spyOn(repo, 'saveMany');
    const slo = makeAvailabilitySLO('a');
    await repo.save(slo);
    const prom = new InMemoryPromStub();
    prom.set('success_ratio{name="a"}', 0.5);
    const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
    const computer = new SLOComputer({ prom, slos: repo, bus, clock });
    await computer.runOnce();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
