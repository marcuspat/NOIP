// Dashboard HTTP tests — supertest against the composed routers with
// in-memory repos / a fake bus and an inline stubbed supplier.

import express from 'express';
import request from 'supertest';
import {
  composeDashboard,
  type DashboardPublicApi,
} from '../../../src/contexts/dashboard/api';
import {
  FixedClock,
  type DomainEvent,
  type EventBus,
  newId,
  type UserId,
} from '../../../src/shared/kernel';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeBus(): EventBus {
  const sink: DomainEvent<unknown>[] = [];
  void sink;
  return {
    publish: () => undefined,
    publishMany: () => undefined,
    subscribe: () => () => undefined,
  };
}

async function buildApp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noip-dashhttp-'));
  const composed = composeDashboard({
    bus: makeBus(),
    clock: new FixedClock(new Date('2026-05-10T00:00:00.000Z')),
    useInMemoryRepos: true,
    storageOpts: { localFs: { root } },
    suppliers: {
      security: {
        async getScore() {
          return {
            score: 88,
            counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          };
        },
        async listFindings() {
          return [];
        },
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', composed.routers.dashboard);
  app.use('/api/reports', composed.routers.report);
  return { app, composed, root };
}

const userId = newId<UserId>();

describe('Dashboard HTTP — /api/dashboard', () => {
  it('returns 400 when creating without an x-user-id', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/dashboard')
      .send({ name: 'A', layout: 'grid' });
    expect(res.status).toBe(400);
  });

  it('POST / creates a dashboard for the authenticated user', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/dashboard')
      .set('x-user-id', userId)
      .send({ name: 'My', layout: 'grid' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.ownedBy.userId).toBe(userId);
  });

  it('GET /:id returns 404 on an unknown id', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .get('/api/dashboard/00000000-0000-7000-8000-000000000999')
      .set('x-user-id', userId);
    expect(res.status).toBe(404);
  });

  it('GET /:id returns 403 to non-owner of a private dashboard', async () => {
    const { app } = await buildApp();
    const created = await request(app)
      .post('/api/dashboard')
      .set('x-user-id', userId)
      .send({ name: 'My', layout: 'grid' });
    const otherUserId = newId<UserId>();
    const res = await request(app)
      .get(`/api/dashboard/${created.body.data.id}`)
      .set('x-user-id', otherUserId);
    expect(res.status).toBe(403);
  });

  it('POST /:id/share replaces the policy', async () => {
    const { app } = await buildApp();
    const created = await request(app)
      .post('/api/dashboard')
      .set('x-user-id', userId)
      .send({ name: 'My', layout: 'grid' });
    const id = created.body.data.id;
    const res = await request(app)
      .post(`/api/dashboard/${id}/share`)
      .set('x-user-id', userId)
      .send({ visibility: 'organisation' });
    expect(res.status).toBe(200);
    expect(res.body.data.share.visibility).toBe('organisation');
  });

  it('GET /widget/:id/data resolves data via the security supplier', async () => {
    const { app } = await buildApp();
    const created = await request(app)
      .post('/api/dashboard')
      .set('x-user-id', userId)
      .send({
        name: 'My',
        layout: 'grid',
        widgets: [
          {
            type: 'metric',
            title: 'Sec',
            datasource: {
              contextRef: 'security',
              query: 'score',
              parameters: { clusterId: 'c1' },
            },
            position: { x: 0, y: 0, w: 2, h: 2 },
          },
        ],
      });
    const dashboardId = created.body.data.id;
    const widgetId = created.body.data.widgets[0].id;
    const res = await request(app)
      .get(`/api/dashboard/widget/${widgetId}/data`)
      .query({ dashboardId })
      .set('x-user-id', userId);
    expect(res.status).toBe(200);
    expect(res.body.data.payload.score).toBe(88);
  });

  it('DELETE /:id removes and returns deleted=true', async () => {
    const { app } = await buildApp();
    const created = await request(app)
      .post('/api/dashboard')
      .set('x-user-id', userId)
      .send({ name: 'My', layout: 'grid' });
    const res = await request(app)
      .delete(`/api/dashboard/${created.body.data.id}`)
      .set('x-user-id', userId);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });
});

describe('Dashboard HTTP — /api/reports', () => {
  it('POST / generates a JSON report and persists it', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/reports')
      .set('x-user-id', userId)
      .send({ kind: 'executive_summary', format: 'json', scope: {} });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('generated');
    expect(res.body.data.artifactKey).toBeDefined();
  });

  it('GET / lists reports', async () => {
    const { app } = await buildApp();
    await request(app)
      .post('/api/reports')
      .set('x-user-id', userId)
      .send({ kind: 'executive_summary', format: 'json', scope: {} });
    const res = await request(app).get('/api/reports').set('x-user-id', userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /:id/artifact streams the artifact bytes', async () => {
    const { app } = await buildApp();
    const created = await request(app)
      .post('/api/reports')
      .set('x-user-id', userId)
      .send({ kind: 'compliance', format: 'csv', scope: {} });
    const res = await request(app)
      .get(`/api/reports/${created.body.data.id}/artifact`)
      .set('x-user-id', userId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('panelId,panelTitle');
  });

  it('POST / rejects unsupported formats', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/reports')
      .set('x-user-id', userId)
      .send({ kind: 'executive_summary', format: 'docx', scope: {} });
    expect(res.status).toBe(400);
  });
});

describe('composeDashboard publicApi', () => {
  it('exposes a getDashboard that returns null instead of throwing', async () => {
    const { composed } = await buildApp();
    const api: DashboardPublicApi = composed.publicApi;
    const result = await api.getDashboard(
      '00000000-0000-7000-8000-000000000999' as never,
      { userId: userId }
    );
    expect(result).toBeNull();
  });
});
