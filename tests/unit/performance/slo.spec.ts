// SLO aggregate invariants.

import { SLO } from '../../../src/contexts/performance/domain/slo';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('SLO aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function make(): SLO {
    return SLO.create(
      {
        name: 'api-availability',
        target: { kind: 'availability', value: 0.999 },
        window: { rollingDays: 28 },
        indicators: [{ query: 'up{job="api"}' }],
      },
      clock
    );
  }

  it('creates with full budget and no burn', () => {
    const s = make();
    expect(s.currentBurnRate).toBe(0);
    expect(s.remainingBudget).toBe(1);
    expect(s.breached).toBe(false);
  });

  it('rejects empty name', () => {
    expect(() =>
      SLO.create(
        {
          name: '',
          target: { kind: 'availability', value: 0.99 },
          window: { rollingDays: 28 },
          indicators: [{ query: 'q' }],
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects missing indicators', () => {
    expect(() =>
      SLO.create(
        {
          name: 'x',
          target: { kind: 'availability', value: 0.99 },
          window: { rollingDays: 28 },
          indicators: [],
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects out-of-range availability target', () => {
    expect(() =>
      SLO.create(
        {
          name: 'x',
          target: { kind: 'availability', value: 1.5 },
          window: { rollingDays: 28 },
          indicators: [{ query: 'q' }],
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects negative latency target', () => {
    expect(() =>
      SLO.create(
        {
          name: 'x',
          target: { kind: 'latency_ms', value: -1 },
          window: { rollingDays: 28 },
          indicators: [{ query: 'q' }],
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('update rejects budget field injection', () => {
    const s = make();
    expect(() =>
      s.update(
        { remainingBudget: 0 } as unknown as Parameters<typeof s.update>[0],
        clock
      )
    ).toThrow(ValidationError);
    expect(() =>
      s.update(
        { currentBurnRate: 5 } as unknown as Parameters<typeof s.update>[0],
        clock
      )
    ).toThrow(ValidationError);
  });

  it('recordObservation emits breached when burnRate > 1', () => {
    const s = make();
    s.recordObservation(2.5, 0, clock);
    expect(s.breached).toBe(true);
    expect(s.currentBurnRate).toBe(2.5);
    expect(s.remainingBudget).toBe(0);
    const events = s.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('performance.slo.breached');
  });

  it('recordObservation emits recovered when burnRate returns ≤ 1', () => {
    const s = make();
    s.recordObservation(2, 0, clock);
    s.drainEvents();
    s.recordObservation(0.5, 0.5, clock);
    expect(s.breached).toBe(false);
    const events = s.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('performance.slo.recovered');
  });

  it('recordObservation does not emit when status unchanged', () => {
    const s = make();
    s.recordObservation(0.5, 0.5, clock);
    expect(s.drainEvents()).toHaveLength(0);
    s.recordObservation(2, 0, clock);
    s.drainEvents();
    s.recordObservation(3, 0, clock);
    // Still breached → no recovered/breached event on the second tick.
    expect(s.drainEvents()).toHaveLength(0);
  });

  it('rejects invalid observation values', () => {
    const s = make();
    expect(() => s.recordObservation(-1, 0.5, clock)).toThrow(ValidationError);
    expect(() => s.recordObservation(Number.NaN, 0.5, clock)).toThrow(
      ValidationError
    );
    expect(() => s.recordObservation(1, 1.5, clock)).toThrow(ValidationError);
    expect(() => s.recordObservation(1, -0.1, clock)).toThrow(ValidationError);
  });

  it('round-trips persistence', () => {
    const s = make();
    s.recordObservation(0.4, 0.6, clock);
    const reloaded = SLO.fromPersistence(s.toPersistence());
    expect(reloaded.id).toBe(s.id);
    expect(reloaded.currentBurnRate).toBeCloseTo(0.4);
    expect(reloaded.remainingBudget).toBeCloseTo(0.6);
    expect(reloaded.indicators).toHaveLength(1);
  });
});
