// Micro-bench for `ArchiveService.archiveOlderThan` against the
// in-memory repo + store. Not a unit test — asserts nothing; just
// prints a single-line summary so CI / local runs surface trends.
//
// Run with:
//   npx jest tests/performance/audit-archive.bench.test.ts --runInBand

import { performance } from 'perf_hooks';

import { FixedClock, InMemoryEventBus } from '../../src/shared/kernel';
import { ArchiveService } from '../../src/contexts/audit/application/archive.service';
import { RetentionPolicy } from '../../src/contexts/audit/domain/retention-policy';
import type { PolicyId } from '../../src/shared/kernel';
import {
  InMemoryArchiveStore,
  InMemoryAuditLogRepository,
  InMemoryRetentionPolicyRepository,
  buildChain,
} from '../unit/audit/contexts/_fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('audit-archive.bench', () => {
  it('measures throughput of archive sweep across 10k entries (5 shards x 2k)', async () => {
    const N_PER_SHARD = 2000;
    const SHARDS = ['s1', 's2', 's3', 's4', 's5'];
    const now = new Date('2026-05-16T00:00:00Z');
    const oldDay = new Date(now.getTime() - 10 * DAY_MS);

    const auditRepo = new InMemoryAuditLogRepository();
    for (const s of SHARDS) {
      for (const e of buildChain({
        count: N_PER_SHARD,
        startAt: oldDay,
        shard: s,
      })) {
        auditRepo.push(e);
      }
    }
    const store = new InMemoryArchiveStore();
    const bus = new InMemoryEventBus();
    const retentionRepo = new InMemoryRetentionPolicyRepository();
    retentionRepo.setPolicy(
      RetentionPolicy.create({
        id: 'p' as PolicyId,
        collection: 'auditLogs',
        archiveAfterDays: 7,
        retentionDays: 365,
        immutable: false,
      })
    );
    const service = new ArchiveService({
      auditLogRepo: auditRepo,
      retentionRepo,
      store,
      bus,
      clock: new FixedClock(now),
      flushEvery: 500,
    });

    // Warm up V8.
    for (let i = 0; i < 2; i++) {
      const warmupRepo = new InMemoryAuditLogRepository();
      for (const e of buildChain({
        count: 100,
        startAt: oldDay,
        shard: 'warmup',
      })) {
        warmupRepo.push(e);
      }
      const warmupSvc = new ArchiveService({
        auditLogRepo: warmupRepo,
        retentionRepo,
        store: new InMemoryArchiveStore(),
        bus,
        clock: new FixedClock(now),
      });
      await warmupSvc.archiveOlderThan(7);
    }

    const start = performance.now();
    const summary = await service.archiveOlderThan(7);
    const elapsedMs = performance.now() - start;

    const totalEntries = SHARDS.length * N_PER_SHARD;
    const throughput = (totalEntries / elapsedMs) * 1000;
    // Print only — no assertion. The bench passes whenever it terminates.

    console.log(
      `[audit-archive.bench] entries=${totalEntries} shards=${SHARDS.length} elapsed=${elapsedMs.toFixed(1)}ms throughput=${throughput.toFixed(0)}/s bytes=${summary.totalBytes}`
    );
    expect(summary.failures).toEqual([]);
    expect(summary.archivedEntries).toBe(totalEntries);
  });
});
