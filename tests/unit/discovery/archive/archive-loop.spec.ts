// Unit tests for `DiscoveryScheduler.startArchiveLoop` / `archiveTick`.
//
// We bypass `setInterval` and call `archiveTick` directly so we don't
// depend on real timers. The `startArchiveLoop` -> `stop` lifecycle is
// validated separately with jest fake timers.

import { DiscoveryScheduler } from '../../../../src/contexts/discovery/application/scheduler';
import { FixedClock, type ClusterId } from '../../../../src/shared/kernel';
import type { SnapshotArchiver } from '../../../../src/contexts/discovery/domain/snapshot-archiver';

interface FakeArchiverHandle {
  archiver: SnapshotArchiver;
  calls: Array<{ method: 'sweep' | 'prune'; opts: unknown }>;
  state: {
    sweep: { archived: number; skipped: number; failed: number };
    prune: { deleted: number };
  };
}

function makeArchiver(): FakeArchiverHandle {
  const handle: FakeArchiverHandle = {
    calls: [],
    state: {
      sweep: { archived: 0, skipped: 0, failed: 0 },
      prune: { deleted: 0 },
    },
    archiver: null as unknown as SnapshotArchiver,
  };
  const fake = {
    archiveOlderThan: jest.fn(async (opts: unknown) => {
      handle.calls.push({ method: 'sweep', opts });
      return {
        scanned: 0,
        archived: handle.state.sweep.archived,
        skipped: handle.state.sweep.skipped,
        failed: handle.state.sweep.failed,
        totalBytes: 0,
        failures: [],
      };
    }),
    pruneArchivedOlderThan: jest.fn(async (opts: unknown) => {
      handle.calls.push({ method: 'prune', opts });
      return {
        deleted: handle.state.prune.deleted,
        scanned: 0,
        missing: 0,
      };
    }),
  };
  handle.archiver = fake as unknown as SnapshotArchiver;
  return handle;
}

function makeService() {
  return {
    triggerScan: jest.fn(async () => ({})),
  };
}

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

describe('DiscoveryScheduler.archiveTick', () => {
  it('calls archiveOlderThan then pruneArchivedOlderThan with forwarded opts', async () => {
    const handle = makeArchiver();
    const { archiver, calls } = handle;
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver,
    });

    const res = await scheduler.archiveTick({
      intervalMs: 1000,
      archiveAfterDays: 90,
      retentionAfterArchiveDays: 30,
      maxBatch: 50,
    });
    expect(res).toEqual({ archived: 0, pruned: 0, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('sweep');
    expect(calls[0]!.opts).toEqual({ olderThanDays: 90, maxBatch: 50 });
    expect(calls[1]!.method).toBe('prune');
    expect(calls[1]!.opts).toEqual({ olderThanDays: 30, maxBatch: 50 });
  });

  it('aggregates counts from sweep and prune', async () => {
    const m = makeArchiver();
    m.state.sweep = { archived: 7, skipped: 1, failed: 2 };
    m.state.prune = { deleted: 4 };
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver: m.archiver,
    });
    const res = await scheduler.archiveTick({ intervalMs: 1000 });
    expect(res).toEqual({ archived: 7, pruned: 4, failed: 2 });
  });

  it('is a no-op without an archiver wired', async () => {
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
    });
    const res = await scheduler.archiveTick({ intervalMs: 1000 });
    expect(res).toBeNull();
  });

  it('returns null when stopped', async () => {
    const { archiver } = makeArchiver();
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver,
    });
    scheduler.stop();
    const res = await scheduler.archiveTick({ intervalMs: 1000 });
    expect(res).toBeNull();
  });

  it('captures sweep failures and returns failed:1', async () => {
    const { archiver } = makeArchiver();
    (
      archiver as unknown as {
        archiveOlderThan: jest.Mock;
      }
    ).archiveOlderThan = jest.fn(async () => {
      throw new Error('mongo down');
    });
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver,
    });
    const res = await scheduler.archiveTick({ intervalMs: 1000 });
    expect(res).toEqual({ archived: 0, pruned: 0, failed: 1 });
  });

  it('skips re-entrant ticks while a prior tick is still in flight', async () => {
    let resolveFirst: () => void = () => {};
    const block = new Promise<void>(res => {
      resolveFirst = res;
    });
    const fake = {
      archiveOlderThan: jest.fn(async () => {
        await block;
        return {
          scanned: 0,
          archived: 0,
          skipped: 0,
          failed: 0,
          totalBytes: 0,
          failures: [],
        };
      }),
      pruneArchivedOlderThan: jest.fn(async () => ({
        deleted: 0,
        scanned: 0,
        missing: 0,
      })),
    };
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver: fake as unknown as SnapshotArchiver,
    });

    const first = scheduler.archiveTick({ intervalMs: 1000 });
    // Second call should return null immediately because the prior is in-flight.
    const second = await scheduler.archiveTick({ intervalMs: 1000 });
    expect(second).toBeNull();
    resolveFirst();
    const r1 = await first;
    expect(r1).not.toBeNull();
    expect(fake.archiveOlderThan).toHaveBeenCalledTimes(1);
  });
});

describe('DiscoveryScheduler.startArchiveLoop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts a timer that fires archiveTick on the supplied cadence', () => {
    const { archiver } = makeArchiver();
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver,
    });
    scheduler.startArchiveLoop({ intervalMs: 60_000 });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    jest.advanceTimersByTime(60_000);
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is a no-op when the archiver dependency is missing', () => {
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
    });
    scheduler.startArchiveLoop({ intervalMs: 60_000 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('start/stop is idempotent', () => {
    const { archiver } = makeArchiver();
    const scheduler = new DiscoveryScheduler({
      discoveryService: makeService() as never,
      clusters: async () => [],
      clock,
      archiver,
    });
    scheduler.startArchiveLoop({ intervalMs: 1000 });
    scheduler.startArchiveLoop({ intervalMs: 1000 }); // no-op
    scheduler.stop();
    scheduler.stop(); // idempotent
    expect(jest.getTimerCount()).toBe(0);
  });
});
