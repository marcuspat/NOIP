// Unit tests for `SnapshotArchiver.pruneArchivedOlderThan`.
//
// Covers the verify-before-delete contract: a row whose archive
// cannot be found in cold storage is NEVER hard-deleted from Mongo.

import { SnapshotArchiver } from '../../../../src/contexts/discovery/domain/snapshot-archiver';
import {
  FixedClock,
  InMemoryEventBus,
  type ClusterId,
  type SnapshotId,
} from '../../../../src/shared/kernel';
import { InMemoryArchiveStore, InMemorySnapshotRepository } from './fakes';
import { buildArchiveKey } from '../../../../src/contexts/discovery/domain/ports/snapshot-archive-store';

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
    config: {
      archiveAfterDays: 90,
      retentionAfterArchiveDays: 30,
      batchSize: 100,
    },
  });
  return { archiver, repo, store, clock };
}

function seedArchived(
  repo: InMemorySnapshotRepository,
  store: InMemoryArchiveStore,
  args: { id: SnapshotId; takenAt: Date; archivedAt: Date; missing?: boolean }
): string {
  const key = buildArchiveKey({
    clusterId,
    snapshotId: args.id,
    takenAt: args.takenAt,
  });
  if (!args.missing) {
    // Drop a sentinel byte so `exists` returns true.
    store.objects.set(key, new Uint8Array([0]));
  }
  repo.seed({
    id: args.id,
    clusterId,
    takenAt: args.takenAt,
    archived: true,
    archivedAt: args.archivedAt,
    archiveUri: `mem://${key}`,
    archiveSha256: 'deadbeef',
  });
  return key;
}

describe('SnapshotArchiver.pruneArchivedOlderThan', () => {
  it('deletes verified archives older than the retention window', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    seedArchived(repo, store, {
      id: id(1),
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedArchived(repo, store, {
      id: id(2),
      takenAt: new Date('2025-12-02T00:00:00.000Z'),
      archivedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    // Recently archived -> outside retention window, untouched.
    seedArchived(repo, store, {
      id: id(3),
      takenAt: new Date('2026-04-01T00:00:00.000Z'),
      archivedAt: new Date('2026-04-25T00:00:00.000Z'),
    });

    const res = await archiver.pruneArchivedOlderThan({});
    expect(res.deleted).toBe(2);
    expect(res.scanned).toBe(2);
    expect(res.missing).toBe(0);

    expect(await repo.findById(id(1))).toBeNull();
    expect(await repo.findById(id(2))).toBeNull();
    expect(await repo.findById(id(3))).not.toBeNull();
  });

  it('does NOT delete when the archive is missing from cold storage', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    seedArchived(repo, store, {
      id: id(1),
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // Missing in cold storage.
    seedArchived(repo, store, {
      id: id(2),
      takenAt: new Date('2025-12-02T00:00:00.000Z'),
      archivedAt: new Date('2026-01-02T00:00:00.000Z'),
      missing: true,
    });

    const res = await archiver.pruneArchivedOlderThan({});
    expect(res.deleted).toBe(1);
    expect(res.scanned).toBe(2);
    expect(res.missing).toBe(1);
    // id(2) is preserved for operator investigation.
    expect(await repo.findById(id(2))).not.toBeNull();
    expect(await repo.findById(id(1))).toBeNull();
  });

  it('respects maxBatch', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    for (let i = 1; i <= 5; i++) {
      seedArchived(repo, store, {
        id: id(i),
        takenAt: new Date('2025-12-01T00:00:00.000Z'),
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    }
    const res = await archiver.pruneArchivedOlderThan({ maxBatch: 2 });
    expect(res.scanned).toBe(2);
    expect(res.deleted).toBe(2);
  });

  it('returns zeros when no archived snapshots are old enough', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    seedArchived(repo, store, {
      id: id(1),
      takenAt: new Date('2026-04-01T00:00:00.000Z'),
      archivedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const res = await archiver.pruneArchivedOlderThan({});
    expect(res.deleted).toBe(0);
    expect(res.scanned).toBe(0);
  });

  it('treats store.exists exceptions as "missing" and preserves the row', async () => {
    const { archiver, repo, store } = build('2026-05-10T00:00:00.000Z');
    seedArchived(repo, store, {
      id: id(1),
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    store.failExists = true;
    const res = await archiver.pruneArchivedOlderThan({});
    expect(res.deleted).toBe(0);
    expect(res.missing).toBe(1);
    expect(await repo.findById(id(1))).not.toBeNull();
  });
});
