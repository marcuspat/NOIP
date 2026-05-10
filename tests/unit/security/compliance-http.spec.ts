// Compliance HTTP routes — supertest against the new router with a
// stubbed ComplianceService.

import express from 'express';
import request from 'supertest';
import complianceRoutes from '../../../src/contexts/security/http/compliance.routes';
import type { ComplianceService } from '../../../src/contexts/security/application/compliance.service';
import { ComplianceReport } from '../../../src/contexts/security/domain/compliance-report';
import {
  FixedClock,
  newId,
  type ClusterId,
  type ReportId,
  type UserId,
} from '../../../src/shared/kernel';
import { NotFoundError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
const validClusterId = '00000000-0000-7000-8000-000000000123';
const validReportId = '00000000-0000-7000-8000-000000000456';

function appWith(svc: Partial<ComplianceService>): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/compliance', complianceRoutes(svc as ComplianceService));
  return app;
}

function makeReport(): ComplianceReport {
  const r = ComplianceReport.generate(
    {
      framework: 'SOC2',
      scope: { clusterId: validClusterId as ClusterId },
      controls: [],
      overall: { score: 100, pass: 0, fail: 0, partial: 0, na: 0, total: 0 },
    },
    clock
  );
  r.drainEvents();
  return r;
}

describe('compliance HTTP routes', () => {
  it('GET /frameworks returns the supported frameworks', async () => {
    const app = appWith({
      listFrameworks: () => ['SOC2', 'ISO27001'],
    });
    const res = await request(app).get('/api/compliance/frameworks');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['SOC2', 'ISO27001']);
  });

  it('GET /frameworks/:id/controls rejects unknown framework', async () => {
    const app = appWith({
      listControls: () => [],
    });
    const res = await request(app).get(
      '/api/compliance/frameworks/UNKNOWN/controls'
    );
    expect(res.status).toBe(400);
  });

  it('POST /reports requires framework + clusterId', async () => {
    const app = appWith({
      generateReport: async () => makeReport(),
    });
    const r1 = await request(app).post('/api/compliance/reports').send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .post('/api/compliance/reports')
      .send({ framework: 'SOC2' });
    expect(r2.status).toBe(400);
  });

  it('POST /reports returns 201 with the new report', async () => {
    const report = makeReport();
    const app = appWith({
      generateReport: async () => report,
    });
    const res = await request(app)
      .post('/api/compliance/reports')
      .send({ framework: 'SOC2', clusterId: validClusterId });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(report.id);
  });

  it('GET /reports lists reports', async () => {
    const r = makeReport();
    const app = appWith({
      listReports: async () => [r],
    });
    const res = await request(app).get('/api/compliance/reports');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /reports/:id 404s on missing', async () => {
    const id = newId<ReportId>();
    const app = appWith({
      getReport: async () => {
        throw new NotFoundError('ComplianceReport', id);
      },
    });
    const res = await request(app).get(`/api/compliance/reports/${id}`);
    expect(res.status).toBe(404);
  });

  it('POST /reports/:id/sign requires userId', async () => {
    const app = appWith({
      signReport: async () => makeReport(),
    });
    const r = await request(app)
      .post(`/api/compliance/reports/${validReportId}/sign`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST /reports/:id/sign signs and returns the report', async () => {
    const report = makeReport();
    const userId = newId<UserId>();
    report.sign(userId, clock);
    report.drainEvents();
    const app = appWith({
      signReport: async () => report,
    });
    const res = await request(app)
      .post(`/api/compliance/reports/${validReportId}/sign`)
      .send({ userId });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('signed');
  });
});
