// Tests for src/observability/metrics-endpoint.ts — ADR-0023.
//
// The endpoint is a tiny request handler — we mount it on a fresh
// Express app, hit it via supertest, and assert the response is a
// Prometheus text-format dump with the right Content-Type.

import express from 'express';
import request from 'supertest';

import { metricsEndpoint } from '../../../src/observability/metrics-endpoint';
import { counter, register } from '../../../src/observability/registry';

describe('metrics endpoint', () => {
  it('returns 200 + the Prometheus text format', async () => {
    // Touch a counter so the body has at least one sample line.
    const c = counter('noip_endpoint_smoke', 'help', ['outcome']);
    c.labels({ outcome: 'ok' }).inc();

    const app = express();
    app.get('/metrics', metricsEndpoint());
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# HELP noip_endpoint_smoke');
    expect(res.text).toMatch(/noip_endpoint_smoke\{[^}]*outcome="ok"[^}]*\}\s+1/);
  });

  it('sets a text/plain Content-Type with the OpenMetrics version param', async () => {
    const app = express();
    app.get('/metrics', metricsEndpoint());
    const res = await request(app).get('/metrics');
    // Express may re-order the Content-Type parameters; checking the
    // pieces individually decouples the test from header serialisation
    // order. `register.contentType` is the canonical
    // `text/plain; version=0.0.4; charset=utf-8` string from prom-client.
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(register.contentType).toContain('text/plain');
  });

  it('returns 500 when registry serialisation throws', async () => {
    const app = express();
    app.get('/metrics', metricsEndpoint());

    const spy = jest
      .spyOn(register, 'metrics')
      .mockRejectedValueOnce(new Error('boom'));

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('boom');

    spy.mockRestore();
  });
});
