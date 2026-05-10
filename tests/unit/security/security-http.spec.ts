// Security HTTP routes — supertest against the new router with a
// stubbed SecurityService.

import express from 'express';
import request from 'supertest';
import securityRoutes from '../../../src/contexts/security/http/security.routes';
import type { SecurityService } from '../../../src/contexts/security/application/security.service';
import { Finding } from '../../../src/contexts/security/domain/finding';
import { SecurityPolicy } from '../../../src/contexts/security/domain/security-policy';
import { asPolicyVersion } from '../../../src/contexts/security/domain/value-objects';
import {
  FixedClock,
  newId,
  type ClusterId,
  type FindingId,
  type ScanId,
  type UserId,
} from '../../../src/shared/kernel';
import { NotFoundError, ValidationError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
const validClusterId = '00000000-0000-7000-8000-000000000123';

function appWith(svc: Partial<SecurityService>): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/security', securityRoutes(svc as SecurityService));
  return app;
}

function makeFinding(): Finding {
  const f = Finding.open(
    {
      scanId: newId<ScanId>(),
      scope: { clusterId: newId<ClusterId>() },
      resource: {
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'p',
        namespace: 'default',
      },
      policyId: newId() as never,
      policyVersion: asPolicyVersion(1),
      severity: 'high',
      description: 'x',
      evidence: {
        source: 'test',
        summary: 's',
        capturedAt: clock.nowInstant(),
      },
    },
    clock
  );
  f.drainEvents();
  return f;
}

describe('security HTTP routes', () => {
  it('POST /scan requires clusterId', async () => {
    const app = appWith({
      runScan: async () => ({
        scanId: newId<ScanId>(),
        counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        score: 100,
        findingsOpened: 0,
        findingsReSeen: 0,
        findingsResolved: 0,
      }),
    });
    const noBody = await request(app).post('/api/security/scan').send({});
    expect(noBody.status).toBe(400);
  });

  it('POST /scan returns 202 with the run result', async () => {
    const scanId = newId<ScanId>();
    const app = appWith({
      runScan: async () => ({
        scanId,
        counts: { total: 1, critical: 0, high: 1, medium: 0, low: 0 },
        score: 90,
        findingsOpened: 1,
        findingsReSeen: 0,
        findingsResolved: 0,
      }),
    });
    const res = await request(app)
      .post('/api/security/scan')
      .send({ clusterId: validClusterId });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.scanId).toBe(scanId);
  });

  it('GET /score?clusterId returns a per-cluster score', async () => {
    const app = appWith({
      getScore: async () => ({
        scope: { clusterId: validClusterId as ClusterId },
        score: 80,
        breakdown: { critical: 0, high: 10, medium: 4, low: 6 },
        computedAt: clock.nowInstant(),
      }),
    });
    const res = await request(app)
      .get('/api/security/score')
      .query({ clusterId: validClusterId });
    expect(res.status).toBe(200);
    expect(res.body.data.score).toBe(80);
  });

  it('GET /findings projects toPersistence shape', async () => {
    const f = makeFinding();
    const app = appWith({
      listFindings: async () => [f],
    });
    const res = await request(app)
      .get('/api/security/findings')
      .query({ clusterId: validClusterId });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(f.id);
    expect(res.body.data[0].status).toBe('open');
  });

  it('PATCH /findings/:id acknowledge', async () => {
    const f = makeFinding();
    const app = appWith({
      acknowledgeFinding: async () => f,
    });
    const res = await request(app)
      .patch(`/api/security/findings/${f.id}`)
      .send({ action: 'acknowledge', userId: newId<UserId>() });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH /findings/:id 404 when service throws NotFoundError', async () => {
    const id = newId<FindingId>();
    const app = appWith({
      acknowledgeFinding: async () => {
        throw new NotFoundError('Finding', id);
      },
    });
    const res = await request(app)
      .patch(`/api/security/findings/${id}`)
      .send({ action: 'acknowledge', userId: newId<UserId>() });
    expect(res.status).toBe(404);
  });

  it('PATCH /findings/:id rejects unknown action', async () => {
    const f = makeFinding();
    const app = appWith({
      acknowledgeFinding: async () => f,
    });
    const res = await request(app)
      .patch(`/api/security/findings/${f.id}`)
      .send({ action: 'bogus', userId: newId<UserId>() });
    expect(res.status).toBe(400);
  });

  it('GET /policies projects each policy', async () => {
    const p = SecurityPolicy.create(
      { name: 'p', type: 'k8s', config: {} },
      clock
    );
    const app = appWith({
      listPolicies: async () => [p],
    });
    const res = await request(app).get('/api/security/policies');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('p');
  });

  it('POST /policies returns 201 with the new policy', async () => {
    const p = SecurityPolicy.create(
      { name: 'new', type: 'secrets', config: {} },
      clock
    );
    const app = appWith({
      createPolicy: async () => p,
    });
    const res = await request(app)
      .post('/api/security/policies')
      .send({ name: 'new', type: 'secrets', config: {} });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('new');
  });

  it('POST /policies rejects when type missing', async () => {
    const app = appWith({
      createPolicy: async () => {
        throw new ValidationError('should not get here');
      },
    });
    const res = await request(app)
      .post('/api/security/policies')
      .send({ name: 'no-type' });
    expect(res.status).toBe(400);
  });
});
