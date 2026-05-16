// Tests for src/observability/http-metrics.middleware.ts — ADR-0023.

import express from 'express';
import request from 'supertest';

import { httpMetricsMiddleware } from '../../../src/observability/http-metrics.middleware';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from '../../../src/observability/metrics';

describe('http-metrics middleware', () => {
  function buildApp(): express.Express {
    const app = express();
    app.use(httpMetricsMiddleware());
    app.get('/users/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.get('/teapot', (_req, res) => {
      res.status(418).json({ error: 'teapot' });
    });
    return app;
  }

  it('increments noip_http_requests_total with method/route/status', async () => {
    const before = readCounter('GET', '/users/:id', '200');
    const app = buildApp();
    const res = await request(app).get('/users/abc-123');
    expect(res.status).toBe(200);
    const after = readCounter('GET', '/users/:id', '200');
    expect(after - before).toBe(1);
  });

  it('observes a histogram sample on response finish', async () => {
    const beforeCount = readHistogramCount('/users/:id');
    const app = buildApp();
    await request(app).get('/users/xyz');
    const afterCount = readHistogramCount('/users/:id');
    expect(afterCount - beforeCount).toBe(1);
  });

  it('uses the parameterised req.route.path, not the concrete URL', async () => {
    const before = readCounter('GET', '/users/:id', '200');
    const app = buildApp();
    await request(app).get('/users/another-id');
    await request(app).get('/users/yet-another');
    const after = readCounter('GET', '/users/:id', '200');
    expect(after - before).toBe(2);
    // None of the concrete URLs should have leaked into the label set.
    expect(readCounter('GET', '/users/another-id', '200')).toBe(0);
  });

  it('collapses unmatched routes (404 traffic) into a single label', async () => {
    const app = buildApp();
    const before = readCounter('GET', '__unmatched__', '404');
    await request(app).get('/no/such/path');
    const after = readCounter('GET', '__unmatched__', '404');
    expect(after - before).toBe(1);
  });

  it('records non-200 statuses against the right label', async () => {
    const app = buildApp();
    const before = readCounter('GET', '/teapot', '418');
    await request(app).get('/teapot');
    const after = readCounter('GET', '/teapot', '418');
    expect(after - before).toBe(1);
  });
});

function readCounter(method: string, route: string, status: string): number {
  const values = (
    httpRequestsTotal as unknown as {
      hashMap: Record<
        string,
        { labels: Record<string, string>; value: number }
      >;
    }
  ).hashMap;
  for (const v of Object.values(values)) {
    if (
      v.labels['method'] === method &&
      v.labels['route'] === route &&
      v.labels['status'] === status
    ) {
      return v.value;
    }
  }
  return 0;
}

function readHistogramCount(route: string): number {
  // prom-client histogram exposes per-label observation counts via
  // its internal `hashMap`. Each entry tracks the running count of
  // observations against that label permutation.
  const hashMap = (
    httpRequestDurationSeconds as unknown as {
      hashMap: Record<
        string,
        {
          labels: Record<string, string>;
          count?: number;
          sum?: number;
        }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(hashMap)) {
    if (entry.labels['route'] === route) {
      return entry.count ?? 0;
    }
  }
  return 0;
}
