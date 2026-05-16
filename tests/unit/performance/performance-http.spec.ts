// Performance HTTP routes — supertest against the new router with a
// stubbed PerformanceService.

import express from 'express';
import request from 'supertest';
import performanceRoutes from '../../../src/contexts/performance/http/routes';
import type { PerformanceService } from '../../../src/contexts/performance/application/performance.service';
import { Probe } from '../../../src/contexts/performance/domain/probe';
import { ProbeResult } from '../../../src/contexts/performance/domain/probe-result';
import { LoadTest } from '../../../src/contexts/performance/domain/load-test';
import { SLO } from '../../../src/contexts/performance/domain/slo';
import {
  emptyLoadTestSummary,
  type SLOSnapshot,
} from '../../../src/contexts/performance/domain/value-objects';
import {
  FixedClock,
  newId,
  type ProbeId,
  type SLOId,
} from '../../../src/shared/kernel';
import { NotFoundError } from '../../../src/shared/errors';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
const validUuid = '00000000-0000-7000-8000-000000000123';

function appWith(svc: Partial<PerformanceService>): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/performance', performanceRoutes(svc as PerformanceService));
  return app;
}

describe('performance HTTP routes', () => {
  it('GET /probes lists probes', async () => {
    const probe = Probe.create(
      {
        name: 'p',
        kind: 'http',
        target: 't',
        schedule: { intervalMs: 1000 },
      },
      clock
    );
    const app = appWith({ listProbes: async () => [probe] });
    const res = await request(app).get('/api/performance/probes');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('p');
  });

  it('POST /probes 201 + probe shape', async () => {
    const probe = Probe.create(
      {
        name: 'p',
        kind: 'http',
        target: 't',
        schedule: { intervalMs: 1000 },
      },
      clock
    );
    const app = appWith({ createProbe: async () => probe });
    const res = await request(app)
      .post('/api/performance/probes')
      .send({
        name: 'p',
        kind: 'http',
        target: 't',
        schedule: { intervalMs: 1000 },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(probe.id);
  });

  it('POST /probes rejects unknown kind', async () => {
    const app = appWith({});
    const res = await request(app)
      .post('/api/performance/probes')
      .send({
        name: 'p',
        kind: 'icmp',
        target: 't',
        schedule: { intervalMs: 1000 },
      });
    expect(res.status).toBe(400);
  });

  it('POST /probes rejects missing schedule.intervalMs', async () => {
    const app = appWith({});
    const res = await request(app)
      .post('/api/performance/probes')
      .send({ name: 'p', kind: 'http', target: 't' });
    expect(res.status).toBe(400);
  });

  it('POST /probes/:id/run returns 202 + result', async () => {
    const probeId = newId<ProbeId>();
    const result = ProbeResult.record(
      {
        probeId,
        target: 't',
        latencyMs: 5,
        success: true,
      },
      clock
    );
    const app = appWith({ runProbeNow: async () => result });
    const res = await request(app).post(
      `/api/performance/probes/${validUuid}/run`
    );
    expect(res.status).toBe(202);
    expect(res.body.data.success).toBe(true);
  });

  it('DELETE /probes/:id returns 204', async () => {
    const app = appWith({ deleteProbe: async () => undefined });
    const res = await request(app).delete(
      `/api/performance/probes/${validUuid}`
    );
    expect(res.status).toBe(204);
  });

  it('DELETE /probes/:id maps NotFoundError to 404', async () => {
    const app = appWith({
      deleteProbe: async () => {
        throw new NotFoundError('Probe', validUuid);
      },
    });
    const res = await request(app).delete(
      `/api/performance/probes/${validUuid}`
    );
    expect(res.status).toBe(404);
  });

  it('GET /probes/:id/results returns serialised list', async () => {
    const probeId = newId<ProbeId>();
    const r = ProbeResult.record(
      {
        probeId,
        target: 't',
        latencyMs: 5,
        success: true,
      },
      clock
    );
    const app = appWith({ listProbeResults: async () => [r] });
    const res = await request(app).get(
      `/api/performance/probes/${validUuid}/results`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('POST /load-tests submits + returns 202', async () => {
    const t = LoadTest.submit(
      {
        name: 'x',
        script: '',
        target: 't',
        engine: 'k6',
        profile: { rps: 1, vus: 1, durationSec: 1 },
      },
      clock
    );
    const app = appWith({ submitLoadTest: async () => t });
    const res = await request(app)
      .post('/api/performance/load-tests')
      .send({
        name: 'x',
        script: '',
        target: 't',
        engine: 'k6',
        profile: { rps: 1, vus: 1, durationSec: 1 },
      });
    expect(res.status).toBe(202);
    expect(res.body.data.engine).toBe('k6');
  });

  it('POST /load-tests rejects missing profile.durationSec', async () => {
    const app = appWith({});
    const res = await request(app)
      .post('/api/performance/load-tests')
      .send({ name: 'x', script: '', target: 't', engine: 'k6' });
    expect(res.status).toBe(400);
  });

  it('GET /load-tests/:id returns persisted aggregate', async () => {
    const t = LoadTest.submit(
      {
        name: 'x',
        script: '',
        target: 't',
        engine: 'k6',
        profile: { rps: 1, vus: 1, durationSec: 1 },
      },
      clock
    );
    t.complete(emptyLoadTestSummary(), clock);
    const app = appWith({ getLoadTest: async () => t });
    const res = await request(app).get(
      `/api/performance/load-tests/${validUuid}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('succeeded');
  });

  it('POST /slos 201 + persistence shape', async () => {
    const slo = SLO.create(
      {
        name: 'a',
        target: { kind: 'availability', value: 0.99 },
        window: { rollingDays: 28 },
        indicators: [{ query: 'q' }],
      },
      clock
    );
    const app = appWith({ defineSLO: async () => slo });
    const res = await request(app)
      .post('/api/performance/slos')
      .send({
        name: 'a',
        target: { kind: 'availability', value: 0.99 },
        window: { rollingDays: 28 },
        indicators: [{ query: 'q' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('a');
  });

  it('POST /slos rejects missing target / window / indicators', async () => {
    const app = appWith({});
    for (const body of [
      { name: 'a', window: { rollingDays: 28 }, indicators: [] },
      {
        name: 'a',
        target: { kind: 'availability', value: 0.99 },
        indicators: [],
      },
      {
        name: 'a',
        target: { kind: 'availability', value: 0.99 },
        window: { rollingDays: 28 },
      },
    ]) {
      const res = await request(app).post('/api/performance/slos').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('GET /slos/:id returns the snapshot', async () => {
    const snapshot: SLOSnapshot = {
      sloId: newId<SLOId>(),
      name: 'a',
      target: { kind: 'availability', value: 0.99 },
      window: { rollingDays: 28 },
      currentBurnRate: 0.5,
      remainingBudget: 0.5,
      computedAt: clock.nowInstant(),
    };
    const app = appWith({ getSLOStatus: async () => snapshot });
    const res = await request(app).get(`/api/performance/slos/${validUuid}`);
    expect(res.status).toBe(200);
    expect(res.body.data.remainingBudget).toBe(0.5);
  });

  it('PATCH /probes/:id rejects invalid id format', async () => {
    const app = appWith({});
    const res = await request(app)
      .patch('/api/performance/probes/not-a-uuid')
      .send({ name: 'x' });
    expect(res.status).toBe(400);
  });
});
