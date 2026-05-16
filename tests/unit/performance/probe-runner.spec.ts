// ProbeRunner — dispatches probes to the right adapter and returns
// a `ProbeResult`. Verifies fallback for unimplemented kinds and
// graceful adapter-exception handling.

import { Probe } from '../../../src/contexts/performance/domain/probe';
import { ProbeRunner } from '../../../src/contexts/performance/domain/probe-runner';
import type {
  HttpProbeClient,
  HttpProbeRequest,
  HttpProbeResponse,
} from '../../../src/contexts/performance/domain/ports/http-probe-client';
import { FixedClock } from '../../../src/shared/kernel';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function makeProbe(kind: 'http' | 'tcp' | 'dns' | 'grpc' = 'http'): Probe {
  return Probe.create(
    {
      name: 'p',
      kind,
      target: 'https://t/health',
      schedule: { intervalMs: 1000, timeoutMs: 2000 },
    },
    clock
  );
}

function client(
  impl: (req: HttpProbeRequest) => Promise<HttpProbeResponse>
): HttpProbeClient {
  return { execute: impl };
}

describe('ProbeRunner', () => {
  it('records a successful http probe', async () => {
    const runner = new ProbeRunner({
      http: client(async () => ({
        latencyMs: 12,
        success: true,
        measurements: { statusCode: 200 },
      })),
      clock,
    });
    const result = await runner.run(makeProbe());
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(12);
    expect(result.measurements.statusCode).toBe(200);
  });

  it('records a failed http probe and emits performance.probe.failed', async () => {
    const runner = new ProbeRunner({
      http: client(async () => ({
        latencyMs: 5,
        success: false,
        failureReason: 'HTTP 500',
        measurements: { statusCode: 500 },
      })),
      clock,
    });
    const result = await runner.run(makeProbe());
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('HTTP 500');
    const events = result.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('performance.probe.failed');
  });

  it('translates adapter exceptions into a failed result (never throws)', async () => {
    const runner = new ProbeRunner({
      http: client(async () => {
        throw new Error('connection refused');
      }),
      clock,
    });
    const result = await runner.run(makeProbe());
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('connection refused');
  });

  it('returns a not-implemented failure for non-http kinds', async () => {
    const runner = new ProbeRunner({
      http: client(async () => ({
        latencyMs: 0,
        success: true,
        measurements: {},
      })),
      clock,
    });
    for (const kind of ['tcp', 'dns', 'grpc'] as const) {
      const result = await runner.run(makeProbe(kind));
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('not implemented');
    }
  });

  it('passes probe.schedule.timeoutMs through to the http adapter', async () => {
    let captured = 0;
    const runner = new ProbeRunner({
      http: client(async req => {
        captured = req.timeoutMs;
        return { latencyMs: 1, success: true, measurements: {} };
      }),
      clock,
    });
    await runner.run(makeProbe());
    expect(captured).toBe(2000);
  });

  it('defaults timeoutMs to 5000 when probe schedule omits it', async () => {
    let captured = 0;
    const probe = Probe.create(
      {
        name: 'p',
        kind: 'http',
        target: 't',
        schedule: { intervalMs: 1000 },
      },
      clock
    );
    const runner = new ProbeRunner({
      http: client(async req => {
        captured = req.timeoutMs;
        return { latencyMs: 1, success: true, measurements: {} };
      }),
      clock,
    });
    await runner.run(probe);
    expect(captured).toBe(5000);
  });
});
