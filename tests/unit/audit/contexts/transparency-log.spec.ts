import {
  InMemoryEventBus,
  type DomainEvent,
} from '../../../../src/shared/kernel';
import { TransparencyLogService } from '../../../../src/contexts/audit/application/transparency-log.service';
import { TransparencyLogStub } from '../../../../src/contexts/audit/infrastructure/transparency/transparency-log-stub';
import { HashChainAppender } from '../../../../src/contexts/audit/application/hash-chain-appender.service';
import { InMemoryAuditCollection, CapturingLogger } from '../_stubs';
import {
  InMemoryAuditLogRepository,
  buildChain,
  fixedClock,
  TEST_CLOCK_AT,
} from './_fixtures';

function build(): {
  service: TransparencyLogService;
  log: TransparencyLogStub;
  auditRepo: InMemoryAuditLogRepository;
  collection: InMemoryAuditCollection;
  appender: HashChainAppender;
  bus: InMemoryEventBus;
  events: DomainEvent<unknown>[];
  logger: CapturingLogger;
} {
  const auditRepo = new InMemoryAuditLogRepository();
  const collection = new InMemoryAuditCollection();
  const logger = new CapturingLogger();
  const bus = new InMemoryEventBus();
  const events: DomainEvent<unknown>[] = [];
  bus.subscribe('audit.chain.broken', evt => events.push(evt));
  const appender = new HashChainAppender({
    collection,
    clock: fixedClock(),
    logger,
    eventBus: bus,
  });
  const log = new TransparencyLogStub({ now: () => TEST_CLOCK_AT });
  const service = new TransparencyLogService({
    auditLogRepo: auditRepo,
    appender,
    transparencyLog: log,
    bus,
    clock: fixedClock(),
    logger,
  });
  return { service, log, auditRepo, collection, appender, bus, events, logger };
}

describe('TransparencyLogService.submitChainTips', () => {
  it('submits one tip per shard', async () => {
    const { service, log, auditRepo } = build();
    const chainA = buildChain({ count: 3, startAt: TEST_CLOCK_AT, shard: 'a' });
    const chainB = buildChain({ count: 2, startAt: TEST_CLOCK_AT, shard: 'b' });
    for (const e of chainA) auditRepo.push(e);
    for (const e of chainB) auditRepo.push(e);

    const summary = await service.submitChainTips();
    expect(summary.submitted).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(log.submissions).toHaveLength(2);
    const shards = log.submissions.map(s => s.shard).sort();
    expect(shards).toEqual(['a', 'b']);
    // Tip submitted should match the latest chain entry's currentHash.
    const aTip = log.submissions.find(s => s.shard === 'a')!;
    expect(aTip.sequence).toBe(2);
    expect(aTip.tipHash).toBe(chainA[2]!.chain.currentHash);
  });

  it('is idempotent on (shard, sequence) — re-submits return the same logIndex', async () => {
    const { service, log, auditRepo } = build();
    for (const e of buildChain({ count: 2, startAt: TEST_CLOCK_AT })) {
      auditRepo.push(e);
    }
    const first = await service.submitChainTips();
    const indexFirst = first.receipts[0]?.logIndex;
    const second = await service.submitChainTips();
    expect(second.receipts[0]?.logIndex).toBe(indexFirst);
    // Stub records two submissions in `submissions` history but only one receipt.
    expect(log.receipts.size).toBe(1);
  });

  it('records failures into the summary and keeps going', async () => {
    const { service, log, auditRepo } = build();
    for (const e of buildChain({
      count: 2,
      startAt: TEST_CLOCK_AT,
      shard: 'a',
    })) {
      auditRepo.push(e);
    }
    for (const e of buildChain({
      count: 2,
      startAt: TEST_CLOCK_AT,
      shard: 'b',
    })) {
      auditRepo.push(e);
    }
    log.failNext(new Error('rekor unavailable'));
    const summary = await service.submitChainTips();
    expect(summary.failed).toBe(1);
    expect(summary.submitted).toBe(1);
    expect(summary.failures[0]?.error).toMatch(/rekor unavailable/);
  });

  it('skips shards with no entries', async () => {
    const { service } = build();
    const summary = await service.submitChainTips('empty-shard');
    expect(summary.submitted).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('targets a single shard when one is supplied', async () => {
    const { service, log, auditRepo } = build();
    for (const e of buildChain({
      count: 1,
      startAt: TEST_CLOCK_AT,
      shard: 'a',
    })) {
      auditRepo.push(e);
    }
    for (const e of buildChain({
      count: 1,
      startAt: TEST_CLOCK_AT,
      shard: 'b',
    })) {
      auditRepo.push(e);
    }
    const summary = await service.submitChainTips('a');
    expect(summary.submitted).toBe(1);
    expect(log.submissions).toHaveLength(1);
    expect(log.submissions[0]?.shard).toBe('a');
  });
});

describe('TransparencyLogService.verifyChainIntegrity', () => {
  it('reports ok=true on an intact chain', async () => {
    const { service, auditRepo, collection } = build();
    const chain = buildChain({ count: 3, startAt: TEST_CLOCK_AT });
    for (const e of chain) {
      auditRepo.push(e);
      collection.entries.push(e);
    }
    const reports = await service.verifyChainIntegrity();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(true);
    expect(reports[0]?.checked).toBe(3);
  });

  it('emits audit.chain.broken on a tampered chain', async () => {
    const { service, auditRepo, collection, events } = build();
    const chain = buildChain({ count: 3, startAt: TEST_CLOCK_AT });
    for (const e of chain) {
      auditRepo.push(e);
      collection.entries.push(e);
    }
    // Tamper with sequence 1
    collection.mutateAt(1, e => {
      e.details = { method: 'PATCH' };
    });
    const reports = await service.verifyChainIntegrity();
    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.brokenAtSequence).toBe(1);
    // Two `audit.chain.broken` events should have flowed: one from the
    // appender's verifyRange + one from the verifier service's
    // higher-level emit. Both keyed on shard='global'.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.type === 'audit.chain.broken')).toBe(true);
  });

  it('returns an empty report when no entries exist', async () => {
    const { service } = build();
    const reports = await service.verifyChainIntegrity();
    expect(reports).toEqual([]);
  });

  it('reports ok=true for an empty target shard', async () => {
    const { service, auditRepo, collection } = build();
    for (const e of buildChain({
      count: 1,
      startAt: TEST_CLOCK_AT,
      shard: 'a',
    })) {
      auditRepo.push(e);
      collection.entries.push(e);
    }
    const reports = await service.verifyChainIntegrity('empty');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(true);
    expect(reports[0]?.checked).toBe(0);
  });
});

describe('TransparencyLogStub', () => {
  it('returns the same receipt on repeated submits', async () => {
    const log = new TransparencyLogStub();
    const r1 = await log.submit({
      shard: 'global',
      sequence: 0,
      tipHash: 'abc',
      occurredAt: TEST_CLOCK_AT,
    });
    const r2 = await log.submit({
      shard: 'global',
      sequence: 0,
      tipHash: 'abc',
      occurredAt: TEST_CLOCK_AT,
    });
    expect(r1.logIndex).toBe(r2.logIndex);
    expect(r1.logId).toBe(r2.logId);
  });

  it('lookup returns the recorded receipt', async () => {
    const log = new TransparencyLogStub();
    await log.submit({
      shard: 'global',
      sequence: 7,
      tipHash: 'xyz',
      occurredAt: TEST_CLOCK_AT,
    });
    const got = await log.lookup('global', 7);
    expect(got).not.toBeNull();
    expect(got?.logIndex).toBe(0);
  });

  it('lookup returns null for unknown coordinates', async () => {
    const log = new TransparencyLogStub();
    expect(await log.lookup('global', 99)).toBeNull();
  });
});
