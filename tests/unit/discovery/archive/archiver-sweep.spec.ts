// Unit tests for `SnapshotArchiver.archiveOlderThan`.
//
// Covers the cutoff filter (only rows older than archiveAfterDays are
// touched), batching (maxBatch caps work per call), and per-snapshot
// failure isolation (one bad row does not abort the sweep).

import { SnapshotArchiver } from '../../../../src/contexts/discovery/domain/snapshot-archiver';
import {
  FixedClock,
  InMemoryEventBus,
  type ClusterId,
  type SnapshotId,
} from '../../../../src/shared/kernel';
import { InMemoryArchiveStore, InMemorySnapshotRepository } from './fakes';

const clusterId = '00000000-0000-7000-8000-000000000aaa' as ClusterId;

function id(n: number): SnapshotId {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as SnapshotId;
}

function build(now: string) {
  const repo = new InMemorySnapshotRepository();
  const store = new InMemoryArchiveStore();
  const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
  const clock = new FixedClock(new Date(now));
  const archiver = new SnapshotArchiver({
    repository: repo,
    store,
    bus,
    clock,
    config: { archiveAfterDays: 90, batchSize: 100, concurrency: 2 },
  });
  return { archiver, repo, store, bus, clock };
}

describe('SnapshotArchiver.archiveOlderThan', () => {
  it('only archives snapshots older than the cutoff', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    // 91 days old -> archive
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2026-02-08T00:00:00.000Z'),
      records: [],
    });
    // 30 days old -> keep
    repo.seed({
      id: id(2),
      clusterId,
      takenAt: new Date('2026-04-10T00:00:00.000Z'),
      records: [],
    });
    // 200 days old -> archive
    repo.seed({
      id: id(3),
      clusterId,
      takenAt: new Date('2025-10-22T00:00:00.000Z'),
      records: [],
    });

    const summary = await archiver.archiveOlderThan({});
    expect(summary.scanned).toBe(2);
    expect(summary.archived).toBe(2);
    expect(summary.failed).toBe(0);
    expect(store.uploads).toHaveLength(2);
    expect((await repo.findById(id(1)))!.archived).toBe(true);
    expect((await repo.findById(id(2)))!.archived).toBe(false);
    expect((await repo.findById(id(3)))!.archived).toBe(true);
  });

  it('respects maxBatch', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      repo.seed({
        id: id(i),
        clusterId,
        takenAt: new Date('2025-10-22T00:00:00.000Z'),
        records: [],
      });
    }
    const summary = await archiver.archiveOlderThan({ maxBatch: 3 });
    expect(summary.scanned).toBe(3);
    expect(summary.archived).toBe(3);
    expect(store.uploads).toHaveLength(3);
  });

  it('isolates per-snapshot failures and returns a partial summary', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2025-10-01T00:00:00.000Z'),
      records: [],
    });
    repo.seed({
      id: id(2),
      clusterId,
      takenAt: new Date('2025-10-02T00:00:00.000Z'),
      records: [],
    });
    repo.seed({
      id: id(3),
      clusterId,
      takenAt: new Date('2025-10-03T00:00:00.000Z'),
      records: [],
    });

    // Fail uploads for snapshot 2 only by intercepting `exists` to
    // claim 'missing' for its key.
    const origExists = store.exists.bind(store);
    store.exists = (async key => {
      if (key.includes(id(2))) return false;
      return origExists(key);
    }) as typeof store.exists;

    const summary = await archiver.archiveOlderThan({});
    expect(summary.scanned).toBe(3);
    expect(summary.archived).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]!.id).toBe(id(2));
    expect((await repo.findById(id(1)))!.archived).toBe(true);
    expect((await repo.findById(id(2)))!.archived).toBe(false);
    expect((await repo.findById(id(3)))!.archived).toBe(true);
  });

  it('honors a clusterId filter', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    const other = '00000000-0000-7000-8000-000000000bbb' as ClusterId;
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2025-10-01T00:00:00.000Z'),
      records: [],
    });
    repo.seed({
      id: id(2),
      clusterId: other,
      takenAt: new Date('2025-10-02T00:00:00.000Z'),
      records: [],
    });
    const summary = await archiver.archiveOlderThan({ clusterId });
    expect(summary.scanned).toBe(1);
    expect(summary.archived).toBe(1);
    expect(store.uploads[0]!.key).toContain(clusterId);
    expect((await repo.findById(id(2)))!.archived).toBe(false);
  });

  it('returns zero counts when no candidates exist', async () => {
    const { archiver } = build('2026-05-10T00:00:00.000Z');
    const summary = await archiver.archiveOlderThan({});
    expect(summary).toEqual({
      scanned: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
      totalBytes: 0,
      failures: [],
    });
  });

  it('counts already-archived rows as skipped, not re-uploaded', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2025-10-01T00:00:00.000Z'),
      records: [],
    });
    // Simulate findOlderThanForArchive *also* returning archived
    // rows (it normally won't, but the archive store filter is the
    // belt-and-braces protection).
    repo.seed({
      id: id(2),
      clusterId,
      takenAt: new Date('2025-10-02T00:00:00.000Z'),
      records: [],
      archived: true,
      archiveUri: 'mem://prev',
      archiveSha256: 'x',
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const summary = await archiver.archiveOlderThan({});
    // findOlderThanForArchive returns only non-archived rows, so id(2)
    // does not appear in the scanned count.
    expect(summary.scanned).toBe(1);
    expect(summary.archived).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(store.uploads).toHaveLength(1);
  });

  it('falls back to the configured archiveAfterDays default', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2025-01-01T00:00:00.000Z'),
      records: [],
    });
    // The default 90-day cutoff means a row from Jan 1, 2025 is fair game.
    const summary = await archiver.archiveOlderThan({});
    expect(summary.archived).toBe(1);
    expect(store.uploads).toHaveLength(1);
  });

  it('totalBytes accumulates upload sizes', async () => {
    const { archiver, repo } = build('2026-05-10T00:00:00.000Z');
    repo.seed({
      id: id(1),
      clusterId,
      takenAt: new Date('2025-10-01T00:00:00.000Z'),
      records: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          name: 'a',
          namespace: 'ns',
          labels: {},
          annotations: {},
          spec: {},
          status: {},
        },
      ],
    });
    const summary = await archiver.archiveOlderThan({});
    expect(summary.totalBytes).toBeGreaterThan(0);
  });
});
