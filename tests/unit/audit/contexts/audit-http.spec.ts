import express from 'express';
import request from 'supertest';
import { InMemoryEventBus } from '../../../../src/shared/kernel';
import { AuditService } from '../../../../src/contexts/audit/application/audit.service';
import { HashChainAppender } from '../../../../src/contexts/audit/application/hash-chain-appender.service';
import { createAuditRouter } from '../../../../src/contexts/audit/http/routes';
import { CapturingLogger, InMemoryAuditCollection } from '../_stubs';
import {
  InMemoryAuditLogRepository,
  InMemorySecurityEventRepository,
  buildChain,
  buildEntry,
  buildSecurityEvent,
  fixedClock,
  TEST_CLOCK_AT,
} from './_fixtures';

function buildApp(): {
  app: express.Express;
  auditRepo: InMemoryAuditLogRepository;
  secRepo: InMemorySecurityEventRepository;
  collection: InMemoryAuditCollection;
} {
  const auditRepo = new InMemoryAuditLogRepository();
  const secRepo = new InMemorySecurityEventRepository();
  const collection = new InMemoryAuditCollection();
  const appender = new HashChainAppender({
    collection,
    clock: fixedClock(),
    logger: new CapturingLogger(),
  });
  const service = new AuditService({
    auditLogRepo: auditRepo,
    securityEventRepo: secRepo,
    appender,
    bus: new InMemoryEventBus(),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/audit', createAuditRouter({ service }));
  return { app, auditRepo, secRepo, collection };
}

describe('audit HTTP routes', () => {
  describe('GET /logs', () => {
    it('returns a paged list', async () => {
      const { app, auditRepo } = buildApp();
      for (const e of buildChain({ count: 3, startAt: TEST_CLOCK_AT })) {
        auditRepo.push(e);
      }
      const res = await request(app).get('/api/audit/logs').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.items).toHaveLength(3);
    });

    it('filters by action query param', async () => {
      const { app, auditRepo } = buildApp();
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
      const res = await request(app)
        .get('/api/audit/logs?action=iam.user.create')
        .expect(200);
      expect(res.body.data.total).toBe(1);
    });

    it('rejects invalid limit', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/api/audit/logs?limit=-1')
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid from date', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/api/audit/logs?from=not-a-date')
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /logs/:id', () => {
    it('returns the entry when found', async () => {
      const { app, auditRepo } = buildApp();
      const e = buildEntry({ sequence: 0, timestamp: TEST_CLOCK_AT });
      auditRepo.push(e);
      const res = await request(app)
        .get(`/api/audit/logs/${String(e._id)}`)
        .expect(200);
      expect(res.body.data.action).toBe(e.action);
    });

    it('404s when not found', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/audit/logs/missing').expect(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /logs/verify-chain', () => {
    it('returns ok=true for an intact chain', async () => {
      const { app, auditRepo, collection } = buildApp();
      for (const e of buildChain({ count: 3, startAt: TEST_CLOCK_AT })) {
        auditRepo.push(e);
        collection.entries.push(e);
      }
      const res = await request(app)
        .post('/api/audit/logs/verify-chain')
        .send({})
        .expect(200);
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.checked).toBe(3);
    });

    it('returns ok=false on a tampered chain', async () => {
      const { app, auditRepo, collection } = buildApp();
      for (const e of buildChain({ count: 3, startAt: TEST_CLOCK_AT })) {
        auditRepo.push(e);
        collection.entries.push(e);
      }
      collection.mutateAt(1, e => {
        e.details = { method: 'PATCH' };
      });
      const res = await request(app)
        .post('/api/audit/logs/verify-chain')
        .send({})
        .expect(200);
      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.brokenAtSequence).toBe(1);
    });
  });

  describe('GET /events', () => {
    it('returns the security events', async () => {
      const { app, secRepo } = buildApp();
      secRepo.push(buildSecurityEvent());
      secRepo.push(buildSecurityEvent({ resolved: true }));
      const res = await request(app).get('/api/audit/events').expect(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('filters by severity', async () => {
      const { app, secRepo } = buildApp();
      secRepo.push(buildSecurityEvent({ severity: 'LOW' as never }));
      secRepo.push(buildSecurityEvent({ severity: 'HIGH' as never }));
      const res = await request(app)
        .get('/api/audit/events?severity=HIGH')
        .expect(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('rejects invalid severity', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/api/audit/events?severity=BOGUS')
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /events/:id', () => {
    it('marks the event as resolved', async () => {
      const { app, secRepo } = buildApp();
      const evt = buildSecurityEvent({ resolved: false });
      secRepo.push(evt);
      const res = await request(app)
        .patch(`/api/audit/events/${String(evt._id)}`)
        .send({ resolved: true, by: 'analyst-1', note: 'closed' })
        .expect(200);
      expect(res.body.data.resolved).toBe(true);
      expect(res.body.data.resolvedBy).toBe('analyst-1');
    });

    it('rejects `resolved: false`', async () => {
      const { app, secRepo } = buildApp();
      const evt = buildSecurityEvent({ resolved: true });
      secRepo.push(evt);
      const res = await request(app)
        .patch(`/api/audit/events/${String(evt._id)}`)
        .send({ resolved: false, by: 'analyst-1' })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('requires `by`', async () => {
      const { app, secRepo } = buildApp();
      const evt = buildSecurityEvent({ resolved: false });
      secRepo.push(evt);
      const res = await request(app)
        .patch(`/api/audit/events/${String(evt._id)}`)
        .send({ resolved: true })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('404s when the event does not exist', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch('/api/audit/events/missing')
        .send({ resolved: true, by: 'analyst-1' })
        .expect(404);
      expect(res.body.success).toBe(false);
    });
  });
});
