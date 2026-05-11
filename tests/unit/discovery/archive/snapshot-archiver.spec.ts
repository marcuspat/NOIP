// Unit tests for `SnapshotArchiver.archiveOne`.
//
// Covers the single-snapshot happy path, idempotency, the
// already-archived skip, the checksum-mismatch error path, and the
// event-emission contract documented in DDD-12 / DDD-06.

import { gunzipSync } from 'node:zlib';
import {
  SnapshotArchiver,
  type SnapshotArchivedEvent,
} from '../../../../src/contexts/discovery/domain/snapshot-archiver';
import { IntegrityError } from '../../../../src/contexts/discovery/domain/archive-errors';
import {
  FixedClock,
  InMemoryEventBus,
  type ClusterId,
  type DomainEvent,
  type SnapshotId,
} from '../../../../src/shared/kernel';
import { InMemoryArchiveStore, InMemorySnapshotRepository } from './fakes';
import type { KubernetesResourceRecord } from '../../../../src/contexts/discovery/domain/value-objects';

function rec(name: string): KubernetesResourceRecord {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    name,
    namespace: 'ns',
    labels: { app: name },
    annotations: {},
    spec: { replicas: 1 },
    status: { phase: 'Running' },
  };
}

const clusterId = '00000000-0000-7000-8000-000000000aaa' as ClusterId;
const snapshotId = '00000000-0000-7000-8000-000000000ccc' as SnapshotId;

function build(): {
  archiver: SnapshotArchiver;
  repo: InMemorySnapshotRepository;
  store: InMemoryArchiveStore;
  bus: InMemoryEventBus;
  clock: FixedClock;
} {
  const repo = new InMemorySnapshotRepository();
  const store = new InMemoryArchiveStore();
  const bus = new InMemoryEventBus({ warn: () => {}, error: () => {} });
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const archiver = new SnapshotArchiver({
    repository: repo,
    store,
    bus,
    clock,
  });
  return { archiver, repo, store, bus, clock };
}

describe('SnapshotArchiver.archiveOne', () => {
  it('archives a snapshot end-to-end and emits the discovery.snapshot.archived event', async () => {
    const { archiver, repo, store, bus } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a'), rec('b'), rec('c')],
    });

    const events: SnapshotArchivedEvent[] = [];
    bus.subscribe<SnapshotArchivedEvent['payload']>(
      'discovery.snapshot.archived',
      ev => {
        events.push(ev as SnapshotArchivedEvent);
      }
    );

    const outcome = await archiver.archiveOne(snapshotId);
    expect(outcome.kind).toBe('archived');
    if (outcome.kind !== 'archived') throw new Error('unreachable');
    expect(outcome.uri).toMatch(/^mem:\/\/discovery\/2025\/12\//);
    expect(outcome.size).toBeGreaterThan(0);
    expect(outcome.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Mongo row is flipped.
    const reloaded = await repo.findById(snapshotId);
    expect(reloaded?.archived).toBe(true);
    expect(reloaded?.archiveUri).toBe(outcome.uri);
    expect(reloaded?.archiveSha256).toBe(outcome.checksum);
    expect(reloaded?.archivedAt).toBeInstanceOf(Date);

    // The body landed as gzip; uncompressed contents are JSONL.
    const stored = await store.download(store.uploads[0]!.key);
    const decoded = gunzipSync(Buffer.from(stored)).toString('utf8');
    const lines = decoded.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.kind).toBe('Pod');
    }

    // Exactly one event, correctly shaped.
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe('discovery.snapshot.archived');
    expect(evt.context).toBe('discovery');
    expect(evt.aggregateType).toBe('resource_snapshot');
    expect(evt.aggregateId).toBe(snapshotId);
    expect(evt.payload.snapshotId).toBe(snapshotId);
    expect(evt.payload.clusterId).toBe(clusterId);
    expect(evt.payload.archiveUri).toBe(outcome.uri);
    expect(evt.payload.checksum).toBe(outcome.checksum);
    expect(evt.payload.size).toBe(outcome.size);
  });

  it('returns skipped/already-archived without re-uploading', async () => {
    const { archiver, repo, store, bus } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a')],
      archived: true,
      archiveUri: 'mem://pre/existing',
      archiveSha256: 'deadbeef',
      archivedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const publish = jest.spyOn(bus, 'publish');

    const outcome = await archiver.archiveOne(snapshotId);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'already-archived' });
    expect(store.uploads).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns skipped/not-found when the snapshot has been pruned', async () => {
    const { archiver, store } = build();
    const outcome = await archiver.archiveOne(snapshotId);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'not-found' });
    expect(store.uploads).toHaveLength(0);
  });

  it('idempotent re-run of archiveOne does no new work on the second call', async () => {
    const { archiver, repo, store, bus } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a')],
    });
    const publish = jest.spyOn(bus, 'publish');

    const first = await archiver.archiveOne(snapshotId);
    expect(first.kind).toBe('archived');
    const second = await archiver.archiveOne(snapshotId);
    expect(second).toEqual({ kind: 'skipped', reason: 'already-archived' });
    expect(store.uploads).toHaveLength(1);
    // One publish from the first call.
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('throws IntegrityError and leaves Mongo untouched when the download is corrupted', async () => {
    const { archiver, repo, store, bus } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a')],
    });
    store.corruptOnDownload = true;
    const publish = jest.spyOn(bus, 'publish');

    await expect(archiver.archiveOne(snapshotId)).rejects.toBeInstanceOf(
      IntegrityError
    );

    const reloaded = await repo.findById(snapshotId);
    expect(reloaded?.archived).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws IntegrityError when exists() returns false right after upload', async () => {
    const { archiver, repo, store } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a')],
    });
    // Simulate a bucket that uploads but immediately reports the key
    // as missing (eventually-consistent ghost).
    const origUpload = store.upload.bind(store);
    store.upload = (async (...args) => {
      const r = await origUpload(...args);
      store.missingKeys.add(args[0]);
      return r;
    }) as typeof store.upload;

    await expect(archiver.archiveOne(snapshotId)).rejects.toBeInstanceOf(
      IntegrityError
    );
    const reloaded = await repo.findById(snapshotId);
    expect(reloaded?.archived).toBe(false);
  });

  it('publishes an event whose envelope satisfies the DDD-12 contract', async () => {
    const { archiver, repo, bus } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('x')],
    });
    const captured: DomainEvent<unknown>[] = [];
    bus.subscribe('discovery.snapshot.archived', e => {
      captured.push(e);
    });
    await archiver.archiveOne(snapshotId);
    const evt = captured[0]!;
    expect(typeof evt.id).toBe('string');
    expect(typeof evt.occurredAt).toBe('string');
    expect(evt.schemaVersion).toBe(1);
    expect(evt.actor).toEqual({ type: 'system' });
  });

  it('uses a date-partitioned key layout', async () => {
    const { archiver, repo, store } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-15T10:00:00.000Z'),
      records: [rec('a')],
    });
    await archiver.archiveOne(snapshotId);
    const key = store.uploads[0]!.key;
    expect(key).toMatch(
      new RegExp(`^discovery/2025/12/${clusterId}/${snapshotId}\\.jsonl\\.gz$`)
    );
  });

  it('forwards the sha256 checksum to the store on upload', async () => {
    const { archiver, repo, store } = build();
    repo.seed({
      id: snapshotId,
      clusterId,
      takenAt: new Date('2025-12-01T00:00:00.000Z'),
      records: [rec('a')],
    });
    await archiver.archiveOne(snapshotId);
    expect(store.uploads[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
