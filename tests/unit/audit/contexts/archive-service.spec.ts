import { gunzipSync } from 'zlib';
import {
  InMemoryEventBus,
  type DomainEvent,
} from '../../../../src/shared/kernel';
import { ArchiveService } from '../../../../src/contexts/audit/application/archive.service';
import { RetentionPolicy } from '../../../../src/contexts/audit/domain/retention-policy';
import { buildAuditArchiveKey } from '../../../../src/contexts/audit/domain/ports/archive-store';
import type { PolicyId } from '../../../../src/shared/kernel';
import { CapturingLogger } from '../_stubs';
import {
  InMemoryArchiveStore,
  InMemoryAuditLogRepository,
  InMemoryRetentionPolicyRepository,
  buildChain,
  buildEntry,
  fixedClock,
  TEST_CLOCK_AT,
} from './_fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

function build(opts?: {
  retention?: { archiveAfterDays: number; retentionDays: number };
}): {
  service: ArchiveService;
  store: InMemoryArchiveStore;
  bus: InMemoryEventBus;
  auditRepo: InMemoryAuditLogRepository;
  events: DomainEvent<unknown>[];
  logger: CapturingLogger;
} {
  const auditRepo = new InMemoryAuditLogRepository();
  const store = new InMemoryArchiveStore();
  const bus = new InMemoryEventBus();
  const events: DomainEvent<unknown>[] = [];
  bus.subscribe('audit.archive.completed', evt => events.push(evt));
  const logger = new CapturingLogger();
  const retentionRepo = new InMemoryRetentionPolicyRepository();
  if (opts?.retention) {
    retentionRepo.setPolicy(
      RetentionPolicy.create({
        id: 'audit-retention' as PolicyId,
        collection: 'auditLogs',
        archiveAfterDays: opts.retention.archiveAfterDays,
        retentionDays: opts.retention.retentionDays,
        immutable: false,
      })
    );
  }
  const service = new ArchiveService({
    auditLogRepo: auditRepo,
    retentionRepo,
    store,
    bus,
    clock: fixedClock(),
    logger,
  });
  return { service, store, bus, auditRepo, events, logger };
}

describe('ArchiveService.archiveOlderThan', () => {
  it('archives entries older than cutoff and emits audit.archive.completed', async () => {
    const { service, store, auditRepo, events } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    // 3 entries 10 days ago, 1 entry today.
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 3, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);
    auditRepo.push(buildEntry({ sequence: 99, timestamp: TEST_CLOCK_AT }));

    const summary = await service.archiveOlderThan();
    expect(summary.failures).toEqual([]);
    expect(summary.archivedShardDays).toBe(1);
    expect(summary.archivedEntries).toBe(3);
    expect(summary.uris).toHaveLength(1);

    const key = buildAuditArchiveKey({
      shard: 'global',
      date: new Date(
        Date.UTC(
          oldDay.getUTCFullYear(),
          oldDay.getUTCMonth(),
          oldDay.getUTCDate()
        )
      ),
    });
    expect(store.objects.has(key)).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('audit.archive.completed');
    const payload = events[0]?.payload as {
      shard: string;
      entries: number;
      archiveUri: string;
    };
    expect(payload.shard).toBe('global');
    expect(payload.entries).toBe(3);
    expect(payload.archiveUri).toContain('memory://');
  });

  it('does not delete entries inside the retention window', async () => {
    const { service, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 3, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);

    const summary = await service.archiveOlderThan();
    expect(summary.deletedEntries).toBe(0);
    expect(auditRepo.entries).toHaveLength(3);
  });

  it('hard-deletes entries past retentionDays after successful archive', async () => {
    const { service, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 7 },
    });
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 4, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);
    auditRepo.push(buildEntry({ sequence: 99, timestamp: TEST_CLOCK_AT }));

    const summary = await service.archiveOlderThan();
    expect(summary.archivedEntries).toBe(4);
    expect(summary.deletedEntries).toBe(4);
    // Only the present-day entry remains.
    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0]?.chain.sequence).toBe(99);
  });

  it('is idempotent on re-run (object exists; content matches)', async () => {
    const { service, store, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 3, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);

    await service.archiveOlderThan();
    const firstKeys = Array.from(store.objects.keys()).sort();
    const firstBytes = store.objects.get(firstKeys[0]!);

    // Second run with the same data — overwrites but no diff in content.
    await service.archiveOlderThan();
    const secondKeys = Array.from(store.objects.keys()).sort();
    const secondBytes = store.objects.get(secondKeys[0]!);
    expect(secondKeys).toEqual(firstKeys);
    expect(
      Buffer.compare(Buffer.from(firstBytes!), Buffer.from(secondBytes!))
    ).toBe(0);
  });

  it('captures per-shard-day failures into the summary without aborting other buckets', async () => {
    const { service, store, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    const dayA = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const dayB = new Date(TEST_CLOCK_AT.getTime() - 9 * DAY_MS);
    for (const e of buildChain({ count: 2, startAt: dayA, shard: 'shard-a' })) {
      auditRepo.push(e);
    }
    for (const e of buildChain({ count: 2, startAt: dayB, shard: 'shard-b' })) {
      auditRepo.push(e);
    }
    store.failOnUpload = new Error('S3 outage');
    // First call: all fail.
    const failed = await service.archiveOlderThan();
    expect(failed.archivedShardDays).toBe(0);
    expect(failed.failures.length).toBeGreaterThanOrEqual(2);
    // Recover and re-run.
    store.failOnUpload = null;
    const ok = await service.archiveOlderThan();
    expect(ok.archivedShardDays).toBe(2);
    expect(ok.failures).toEqual([]);
  });

  it('detects checksum mismatch on round-trip and skips delete', async () => {
    const { service, store, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 7 },
    });
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 2, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);
    store.corruptOnDownload = true;
    const summary = await service.archiveOlderThan();
    expect(summary.failures).toHaveLength(1);
    // The corruption may surface as a checksum mismatch (when only
    // the payload is touched) or a gunzip "incorrect header check"
    // (when the magic bytes are clobbered). Either is a verifier
    // failure that must skip the delete.
    expect(summary.failures[0]?.error).toMatch(
      /checksum mismatch|header check|decompress/i
    );
    expect(summary.archivedEntries).toBe(0);
    // No archive succeeded → no delete should happen.
    expect(auditRepo.entries).toHaveLength(2);
  });

  it('emits gzipped JSONL with one canonical-JSON line per entry', async () => {
    const { service, store, auditRepo } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    const oldDay = new Date(TEST_CLOCK_AT.getTime() - 10 * DAY_MS);
    const chain = buildChain({ count: 3, startAt: oldDay });
    for (const e of chain) auditRepo.push(e);

    await service.archiveOlderThan();
    const [key] = Array.from(store.objects.keys());
    expect(key).toBeDefined();
    const decompressed = gunzipSync(Buffer.from(store.objects.get(key!)!));
    const text = decompressed.toString('utf8');
    const lines = text.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj).toHaveProperty('action');
      expect(obj).toHaveProperty('chain');
    }
  });

  it('respects an explicit days override over the policy default', async () => {
    const { service, auditRepo } = build({
      retention: { archiveAfterDays: 90, retentionDays: 365 },
    });
    const fiveDaysAgo = new Date(TEST_CLOCK_AT.getTime() - 5 * DAY_MS);
    for (const e of buildChain({ count: 2, startAt: fiveDaysAgo })) {
      auditRepo.push(e);
    }
    const noopWithPolicy = await service.archiveOlderThan();
    expect(noopWithPolicy.archivedEntries).toBe(0);

    // Force a tighter cutoff via the manual override.
    const tighter = await service.archiveOlderThan(1);
    expect(tighter.archivedEntries).toBe(2);
  });

  it('produces an empty summary when nothing matches', async () => {
    const { service } = build({
      retention: { archiveAfterDays: 7, retentionDays: 365 },
    });
    const summary = await service.archiveOlderThan();
    expect(summary).toEqual({
      archivedShardDays: 0,
      archivedEntries: 0,
      deletedEntries: 0,
      totalBytes: 0,
      failures: [],
      uris: [],
    });
  });
});
