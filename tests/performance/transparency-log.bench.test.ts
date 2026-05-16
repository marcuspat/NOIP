// Micro-bench for `TransparencyLogService.submitChainTips` against
// the in-memory stub. Prints a single-line summary; asserts nothing.
//
// Run with:
//   npx jest tests/performance/transparency-log.bench.test.ts --runInBand

import { performance } from 'perf_hooks';

import { FixedClock, InMemoryEventBus } from '../../src/shared/kernel';
import { HashChainAppender } from '../../src/contexts/audit/application/hash-chain-appender.service';
import { TransparencyLogService } from '../../src/contexts/audit/application/transparency-log.service';
import { TransparencyLogStub } from '../../src/contexts/audit/infrastructure/transparency/transparency-log-stub';
import { CapturingLogger, InMemoryAuditCollection } from '../unit/audit/_stubs';
import {
  InMemoryAuditLogRepository,
  buildChain,
} from '../unit/audit/contexts/_fixtures';

describe('transparency-log.bench', () => {
  it('measures throughput of submitChainTips across 200 shards', async () => {
    const SHARDS = 200;
    const now = new Date('2026-05-16T00:00:00Z');
    const clock = new FixedClock(now);

    const auditRepo = new InMemoryAuditLogRepository();
    for (let i = 0; i < SHARDS; i++) {
      const chain = buildChain({
        count: 10,
        startAt: now,
        shard: `shard-${i}`,
      });
      for (const e of chain) auditRepo.push(e);
    }

    const appender = new HashChainAppender({
      collection: new InMemoryAuditCollection(),
      clock,
      logger: new CapturingLogger(),
    });
    const log = new TransparencyLogStub();
    const service = new TransparencyLogService({
      auditLogRepo: auditRepo,
      appender,
      transparencyLog: log,
      bus: new InMemoryEventBus(),
      clock,
    });

    // Warm up V8.
    await service.submitChainTips('shard-0');

    const start = performance.now();
    const summary = await service.submitChainTips();
    const elapsedMs = performance.now() - start;
    const throughput = (summary.submitted / elapsedMs) * 1000;

    console.log(
      `[transparency-log.bench] shards=${SHARDS} submitted=${summary.submitted} elapsed=${elapsedMs.toFixed(1)}ms throughput=${throughput.toFixed(0)}/s`
    );
    expect(summary.failed).toBe(0);
  });
});
