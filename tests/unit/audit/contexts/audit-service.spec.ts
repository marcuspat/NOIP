import { InMemoryEventBus } from '../../../../src/shared/kernel';
import { HashChainAppender } from '../../../../src/contexts/audit/application/hash-chain-appender.service';
import { AuditService } from '../../../../src/contexts/audit/application/audit.service';
import { InMemoryAuditCollection, CapturingLogger } from '../_stubs';
import {
  InMemoryAuditLogRepository,
  InMemorySecurityEventRepository,
  buildChain,
  buildEntry,
  buildSecurityEvent,
  fixedClock,
  TEST_CLOCK_AT,
} from './_fixtures';

function buildAppender(collection: InMemoryAuditCollection): HashChainAppender {
  return new HashChainAppender({
    collection,
    clock: fixedClock(),
    logger: new CapturingLogger(),
  });
}

function buildService(opts?: { bus?: InMemoryEventBus }): {
  service: AuditService;
  auditRepo: InMemoryAuditLogRepository;
  secRepo: InMemorySecurityEventRepository;
  appender: HashChainAppender;
  bus: InMemoryEventBus;
} {
  const auditRepo = new InMemoryAuditLogRepository();
  const secRepo = new InMemorySecurityEventRepository();
  const bus = opts?.bus ?? new InMemoryEventBus();
  const appenderCollection = new InMemoryAuditCollection();
  const appender = buildAppender(appenderCollection);
  // Mirror entries from the appender collection into the repo so the
  // service sees what the appender writes. Tests that seed the repo
  // directly skip this glue.
  const service = new AuditService({
    auditLogRepo: auditRepo,
    securityEventRepo: secRepo,
    appender,
    bus,
  });
  return { service, auditRepo, secRepo, appender, bus };
}

describe('AuditService', () => {
  describe('query', () => {
    it('returns a paged result with total + offset + limit', async () => {
      const { service, auditRepo } = buildService();
      for (const e of buildChain({ count: 5, startAt: TEST_CLOCK_AT })) {
        auditRepo.push(e);
      }
      const page = await service.query({ limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(1);
      expect(page.items).toHaveLength(2);
    });

    it('filters by action', async () => {
      const { service, auditRepo } = buildService();
      auditRepo.push(
        buildEntry({
          sequence: 0,
          timestamp: TEST_CLOCK_AT,
          action: 'iam.user.create',
        })
      );
      auditRepo.push(
        buildEntry({
          sequence: 1,
          timestamp: TEST_CLOCK_AT,
          action: 'iam.user.delete',
        })
      );
      const page = await service.query({ action: 'iam.user.create' });
      expect(page.total).toBe(1);
      expect(page.items[0]?.action).toBe('iam.user.create');
    });

    it('filters by actor userId', async () => {
      const { service, auditRepo } = buildService();
      auditRepo.push(
        buildEntry({
          sequence: 0,
          timestamp: TEST_CLOCK_AT,
          actor: { userId: 'u1' },
        })
      );
      auditRepo.push(
        buildEntry({
          sequence: 1,
          timestamp: TEST_CLOCK_AT,
          actor: { userId: 'u2' },
        })
      );
      const page = await service.query({ actor: { userId: 'u2' } });
      expect(page.total).toBe(1);
      expect(page.items[0]?.actor.userId).toBe('u2');
    });
  });

  describe('getEntry', () => {
    it('returns the entry when found', async () => {
      const { service, auditRepo } = buildService();
      const e = buildEntry({ sequence: 0, timestamp: TEST_CLOCK_AT });
      auditRepo.push(e);
      const got = await service.getEntry(String(e._id));
      expect(got).not.toBeNull();
      expect(got?.action).toBe(e.action);
    });

    it('returns null when not found', async () => {
      const { service } = buildService();
      expect(await service.getEntry('missing')).toBeNull();
    });
  });

  describe('verifyChainIntegrity', () => {
    it('returns ok=true for an intact chain', async () => {
      const { service, auditRepo, appender } = buildService();
      // Seed the audit-collection used by the appender + the repo.
      const chain = buildChain({ count: 4, startAt: TEST_CLOCK_AT });
      for (const e of chain) auditRepo.push(e);
      // Recreate the appender against a collection that holds the
      // same chain so verifyRange has data to walk.
      const collection = new InMemoryAuditCollection();
      for (const e of chain) collection.entries.push(e);
      const localAppender = buildAppender(collection);
      const localService = new AuditService({
        auditLogRepo: auditRepo,
        securityEventRepo: new InMemorySecurityEventRepository(),
        appender: localAppender,
        bus: new InMemoryEventBus(),
      });
      const report = await localService.verifyChainIntegrity({
        from: new Date(0),
        to: new Date(),
      });
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(4);
      // Suppress lint: appender constant is used to ensure ctor didn't throw
      expect(appender).toBeDefined();
    });

    it('returns ok=true with zero entries when shard is empty', async () => {
      const { service } = buildService();
      const report = await service.verifyChainIntegrity({
        from: new Date(0),
        to: new Date(),
      });
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(0);
    });

    it('returns ok=false and the broken sequence when the chain is tampered', async () => {
      const auditRepo = new InMemoryAuditLogRepository();
      const collection = new InMemoryAuditCollection();
      const chain = buildChain({ count: 4, startAt: TEST_CLOCK_AT });
      for (const e of chain) {
        auditRepo.push(e);
        collection.entries.push(e);
      }
      // Tamper with the second entry's body.
      collection.mutateAt(1, e => {
        e.details = { method: 'PATCH', statusCode: 500 };
      });
      const appender = buildAppender(collection);
      const service = new AuditService({
        auditLogRepo: auditRepo,
        securityEventRepo: new InMemorySecurityEventRepository(),
        appender,
        bus: new InMemoryEventBus(),
      });
      const report = await service.verifyChainIntegrity({
        from: new Date(0),
        to: new Date(),
      });
      expect(report.ok).toBe(false);
      expect(report.brokenAtSequence).toBe(1);
    });
  });

  describe('listSecurityEvents', () => {
    it('passes filters through to the repository', async () => {
      const { service, secRepo } = buildService();
      secRepo.push(
        buildSecurityEvent({ userId: 'u1', resolved: false } as never)
      );
      secRepo.push(
        buildSecurityEvent({ userId: 'u2', resolved: true } as never)
      );
      const out = await service.listSecurityEvents({ resolved: false });
      expect(out).toHaveLength(1);
      expect(out[0]?.userId).toBe('u1');
    });
  });

  describe('resolveSecurityEvent', () => {
    it('returns the updated event on success', async () => {
      const { service, secRepo } = buildService();
      const evt = buildSecurityEvent({ resolved: false });
      secRepo.push(evt);
      const updated = await service.resolveSecurityEvent(
        String(evt._id),
        'analyst-1',
        'investigated'
      );
      expect(updated?.resolved).toBe(true);
      expect(updated?.resolvedBy).toBe('analyst-1');
      expect(updated?.resolutionNotes).toBe('investigated');
    });

    it('returns null when the event does not exist', async () => {
      const { service } = buildService();
      expect(
        await service.resolveSecurityEvent('missing', 'analyst-1')
      ).toBeNull();
    });
  });

  describe('streamEvents', () => {
    it('forwards published events to the handler', async () => {
      const bus = new InMemoryEventBus();
      const { service } = buildService({ bus });
      const captured: string[] = [];
      const off = service.streamEvents(evt => {
        captured.push(evt.type);
      });
      bus.publish({
        id: 'evt-1',
        type: 'iam.session.opened',
        context: 'iam',
        aggregateType: 'session',
        aggregateId: 'sess-1',
        occurredAt: TEST_CLOCK_AT.toISOString(),
        payload: { userId: 'u1' },
        schemaVersion: 1,
      });
      bus.publish({
        id: 'evt-2',
        type: 'audit.chain.broken',
        context: 'audit',
        aggregateType: 'chain',
        aggregateId: 'global',
        occurredAt: TEST_CLOCK_AT.toISOString(),
        payload: {},
        schemaVersion: 1,
      });
      expect(captured).toEqual(['iam.session.opened', 'audit.chain.broken']);
      off();
      bus.publish({
        id: 'evt-3',
        type: 'iam.session.opened',
        context: 'iam',
        aggregateType: 'session',
        aggregateId: 'sess-2',
        occurredAt: TEST_CLOCK_AT.toISOString(),
        payload: {},
        schemaVersion: 1,
      });
      expect(captured).toHaveLength(2);
    });

    it('swallows handler errors without poisoning the stream', async () => {
      const bus = new InMemoryEventBus();
      const { service } = buildService({ bus });
      let calls = 0;
      const off = service.streamEvents(() => {
        calls++;
        throw new Error('handler bug');
      });
      bus.publish({
        id: 'evt-1',
        type: 'security.scan.completed',
        context: 'security',
        aggregateType: 'scan',
        aggregateId: 'scan-1',
        occurredAt: TEST_CLOCK_AT.toISOString(),
        payload: {},
        schemaVersion: 1,
      });
      bus.publish({
        id: 'evt-2',
        type: 'security.scan.completed',
        context: 'security',
        aggregateType: 'scan',
        aggregateId: 'scan-2',
        occurredAt: TEST_CLOCK_AT.toISOString(),
        payload: {},
        schemaVersion: 1,
      });
      expect(calls).toBe(2);
      off();
    });
  });
});
