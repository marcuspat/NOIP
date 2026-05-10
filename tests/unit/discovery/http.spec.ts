// Discovery HTTP tests — supertest against the new router with a
// stubbed DiscoveryService.

import express from 'express';
import request from 'supertest';
import discoveryRoutes from '../../../src/contexts/discovery/http/routes';
import { Cluster } from '../../../src/contexts/discovery/domain/cluster';
import { ResourceSnapshot } from '../../../src/contexts/discovery/domain/resource-snapshot';
import {
  FixedClock,
  type ClusterId,
  type ScanId,
} from '../../../src/shared/kernel';
import { NotFoundError, BackpressureError } from '../../../src/shared/errors';
import type { DiscoveryService } from '../../../src/contexts/discovery/application/discovery.service';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

function appWith(svc: Partial<DiscoveryService>) {
  const app = express();
  app.use(express.json());
  app.use('/api/discovery', discoveryRoutes(svc as DiscoveryService));
  return app;
}

const validId = '00000000-0000-7000-8000-000000000123';

describe('Discovery HTTP routes', () => {
  it('GET /api/discovery/clusters returns persisted projections', async () => {
    const cluster = Cluster.register(
      {
        name: 'p',
        endpoint: 'https://api.example.com',
        credentials: { ref: 'vault://r' },
      },
      clock
    );
    cluster.drainEvents();
    const app = appWith({
      listClusters: async () => [cluster],
    });
    const res = await request(app).get('/api/discovery/clusters');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].endpoint).toBe('https://api.example.com');
  });

  it('POST /api/discovery/clusters validates body', async () => {
    const app = appWith({
      registerCluster: async () => {
        throw new Error('should not be called');
      },
    });
    const res = await request(app)
      .post('/api/discovery/clusters')
      .send({ name: 'p' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/discovery/clusters/:id returns 404 on missing', async () => {
    const app = appWith({
      getCluster: async () => {
        throw new NotFoundError('Cluster', validId);
      },
    });
    const res = await request(app).get(`/api/discovery/clusters/${validId}`);
    expect(res.status).toBe(404);
  });

  it('POST /api/discovery/clusters/:id/scan returns 502 on failed scan', async () => {
    const app = appWith({
      triggerScan: async () => ({
        scanId: 's' as ScanId,
        snapshotId: null,
        driftId: null,
        status: 'failed' as const,
      }),
    });
    const res = await request(app).post(
      `/api/discovery/clusters/${validId}/scan`
    );
    expect(res.status).toBe(502);
  });

  it('POST /api/discovery/clusters/:id/scan accepted on success', async () => {
    const app = appWith({
      triggerScan: async () => ({
        scanId: 's' as ScanId,
        snapshotId: 'snap' as never,
        driftId: null,
        status: 'succeeded' as const,
      }),
    });
    const res = await request(app).post(
      `/api/discovery/clusters/${validId}/scan`
    );
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/discovery/clusters/:id/snapshots returns 503 when adapter shedding', async () => {
    const app = appWith({
      listSnapshots: async () => {
        throw new BackpressureError('shedding');
      },
    });
    const res = await request(app).get(
      `/api/discovery/clusters/${validId}/snapshots`
    );
    expect(res.status).toBe(503);
  });

  it('GET /api/discovery/clusters/:id/resources serves the latest snapshot', async () => {
    const snap = ResourceSnapshot.create(
      validId as ClusterId,
      'scan' as ScanId,
      [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          name: 'p',
          namespace: 'default',
          labels: {},
          annotations: {},
          spec: null,
          status: null,
        },
      ],
      clock
    );
    const app = appWith({
      getLatestSnapshot: async () => snap,
    });
    const res = await request(app).get(
      `/api/discovery/clusters/${validId}/resources`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('p');
  });

  it('GET /api/discovery/cluster (legacy) projects to ClusterInfo', async () => {
    const app = appWith({
      scanCluster: async () => ({
        name: 'fake',
        endpoint: 'https://api',
        version: 'v1',
        nodeCount: 1,
        namespaceCount: 2,
        podCount: 3,
        serviceCount: 4,
        lastScan: clock.now(),
      }),
    });
    const res = await request(app).get('/api/discovery/cluster');
    expect(res.status).toBe(200);
    expect(res.body.data.podCount).toBe(3);
  });

  it('400 on invalid uuid id', async () => {
    const app = appWith({});
    const res = await request(app).get('/api/discovery/clusters/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
