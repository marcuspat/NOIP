// LoadTest aggregate invariants.

import { LoadTest } from '../../../src/contexts/performance/domain/load-test';
import { emptyLoadTestSummary } from '../../../src/contexts/performance/domain/value-objects';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('LoadTest aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function submit(): LoadTest {
    return LoadTest.submit(
      {
        name: 'baseline',
        script: 'export default function () {}',
        target: 'https://t',
        engine: 'k6',
        profile: { rps: 100, vus: 10, durationSec: 30 },
      },
      clock
    );
  }

  it('opens in running status', () => {
    const t = submit();
    expect(t.status).toBe('running');
    expect(t.isCompleted()).toBe(false);
  });

  it('rejects empty name', () => {
    expect(() =>
      LoadTest.submit(
        {
          name: '   ',
          script: 's',
          target: 't',
          engine: 'k6',
          profile: { rps: 1, vus: 1, durationSec: 1 },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects non-positive durationSec', () => {
    expect(() =>
      LoadTest.submit(
        {
          name: 'n',
          script: 's',
          target: 't',
          engine: 'k6',
          profile: { rps: 1, vus: 1, durationSec: 0 },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('complete() emits performance.load_test.completed', () => {
    const t = submit();
    const summary = {
      ...emptyLoadTestSummary(),
      totalRequests: 100,
      successfulRequests: 99,
      failedRequests: 1,
      errorRate: 0.01,
      rps: 100,
      p50Ms: 10,
      p95Ms: 30,
      p99Ms: 80,
    };
    t.complete(summary, clock);
    expect(t.status).toBe('succeeded');
    expect(t.summary.totalRequests).toBe(100);
    const events = t.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('performance.load_test.completed');
  });

  it('is immutable post-run (complete cannot be called twice)', () => {
    const t = submit();
    t.complete(emptyLoadTestSummary(), clock);
    expect(() => t.complete(emptyLoadTestSummary(), clock)).toThrow(
      ValidationError
    );
  });

  it('is immutable post-run (fail cannot be called after complete)', () => {
    const t = submit();
    t.complete(emptyLoadTestSummary(), clock);
    expect(() =>
      t.fail({ code: 'INTERNAL_ERROR', message: 'x' }, clock)
    ).toThrow(ValidationError);
  });

  it('fail() marks failed and emits no completion event', () => {
    const t = submit();
    t.fail({ code: 'PROVIDER_ERROR', message: 'boom' }, clock);
    expect(t.status).toBe('failed');
    expect(t.error?.code).toBe('PROVIDER_ERROR');
    // No completed event on failure.
    expect(t.drainEvents()).toHaveLength(0);
  });

  it('round-trips persistence', () => {
    const t = submit();
    t.complete({ ...emptyLoadTestSummary(), totalRequests: 5, rps: 5 }, clock);
    const reloaded = LoadTest.fromPersistence(t.toPersistence());
    expect(reloaded.id).toBe(t.id);
    expect(reloaded.status).toBe('succeeded');
    expect(reloaded.summary.totalRequests).toBe(5);
  });
});
