// Unit tests for DiscoveryScheduler — start/stop, per-cluster failure
// isolation. We bypass `setInterval` and call `tick()` directly so we
// don't depend on real timers.

import { DiscoveryScheduler } from '../../../src/contexts/discovery/application/scheduler';
import { FixedClock, type ClusterId } from '../../../src/shared/kernel';

function makeFakeService() {
  const calls: ClusterId[] = [];
  const failure = new Map<ClusterId, Error>();
  return {
    calls,
    failure,
    triggerScan: jest.fn(async (id: ClusterId) => {
      calls.push(id);
      const err = failure.get(id);
      if (err) throw err;
      return {
        scanId: 's' as never,
        snapshotId: null,
        driftId: null,
        status: 'succeeded' as const,
      };
    }),
  };
}

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

describe('DiscoveryScheduler', () => {
  it('runs triggerScan once per enabled cluster per tick', async () => {
    const svc = makeFakeService();
    const scheduler = new DiscoveryScheduler({
      // We only need triggerScan; cast to fit the type.
      discoveryService: svc as never,
      clusters: async () => [
        { id: 'a' as ClusterId, enabled: true },
        { id: 'b' as ClusterId, enabled: true },
        { id: 'c' as ClusterId, enabled: false }, // skipped
      ],
      clock,
    });
    const results = await scheduler.tick();
    expect(svc.triggerScan).toHaveBeenCalledTimes(2);
    expect(svc.calls).toEqual(['a', 'b']);
    expect(results.filter(r => r.ok)).toHaveLength(2);
  });

  it('isolates per-cluster failures', async () => {
    const svc = makeFakeService();
    svc.failure.set('b' as ClusterId, new Error('boom'));
    const scheduler = new DiscoveryScheduler({
      discoveryService: svc as never,
      clusters: async () => [
        { id: 'a' as ClusterId, enabled: true },
        { id: 'b' as ClusterId, enabled: true },
        { id: 'c' as ClusterId, enabled: true },
      ],
      clock,
    });
    const results = await scheduler.tick();
    expect(svc.triggerScan).toHaveBeenCalledTimes(3);
    expect(results.filter(r => r.ok)).toHaveLength(2);
    expect(results.find(r => r.clusterId === 'b')!.ok).toBe(false);
  });

  it('start() returns immediately and stop() cancels', () => {
    const svc = makeFakeService();
    const scheduler = new DiscoveryScheduler({
      discoveryService: svc as never,
      clusters: async () => [],
      clock,
    });
    scheduler.start(60_000);
    scheduler.stop();
    // Calling start/stop again is idempotent.
    scheduler.stop();
  });

  it('survives an enumerate() failure by returning an empty pass', async () => {
    const svc = makeFakeService();
    const scheduler = new DiscoveryScheduler({
      discoveryService: svc as never,
      clusters: async () => {
        throw new Error('mongo down');
      },
      clock,
    });
    const results = await scheduler.tick();
    expect(results).toEqual([]);
    expect(svc.triggerScan).not.toHaveBeenCalled();
  });
});
