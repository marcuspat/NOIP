// ProbeResult aggregate invariants.

import { ProbeResult } from '../../../src/contexts/performance/domain/probe-result';
import {
  FixedClock,
  newId,
  type ProbeId,
  type SLOId,
} from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('ProbeResult aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('records a successful probe and emits no event', () => {
    const r = ProbeResult.record(
      {
        probeId: newId<ProbeId>(),
        target: 'https://t',
        latencyMs: 42,
        success: true,
      },
      clock
    );
    expect(r.success).toBe(true);
    expect(r.failureReason).toBeNull();
    expect(r.drainEvents()).toHaveLength(0);
  });

  it('records a failed probe and emits performance.probe.failed', () => {
    const r = ProbeResult.record(
      {
        probeId: newId<ProbeId>(),
        target: 'https://t',
        latencyMs: 100,
        success: false,
        failureReason: 'HTTP 503',
      },
      clock
    );
    const events = r.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('performance.probe.failed');
    const payload = events[0]!.payload as { failureReason: string };
    expect(payload.failureReason).toBe('HTTP 503');
  });

  it('rejects negative latency', () => {
    expect(() =>
      ProbeResult.record(
        {
          probeId: newId<ProbeId>(),
          target: 't',
          latencyMs: -1,
          success: true,
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('requires a failureReason on failed probes', () => {
    expect(() =>
      ProbeResult.record(
        {
          probeId: newId<ProbeId>(),
          target: 't',
          latencyMs: 1,
          success: false,
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('binds an SLO id when supplied', () => {
    const sloId = newId<SLOId>();
    const r = ProbeResult.record(
      {
        probeId: newId<ProbeId>(),
        target: 't',
        latencyMs: 1,
        success: true,
        sloId,
      },
      clock
    );
    expect(r.sloId).toBe(sloId);
  });

  it('round-trips persistence', () => {
    const r = ProbeResult.record(
      {
        probeId: newId<ProbeId>(),
        target: 't',
        latencyMs: 1,
        success: true,
        measurements: { statusCode: 200, bytes: 12 },
      },
      clock
    );
    const reloaded = ProbeResult.fromPersistence(r.toPersistence());
    expect(reloaded.id).toBe(r.id);
    expect(reloaded.measurements.statusCode).toBe(200);
  });
});
