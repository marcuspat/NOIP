import express, { Express } from 'express';
import request from 'supertest';
import {
  createHealthRoutes,
  HealthRouteDeps,
} from '../../src/routes/health.routes';

interface ProbeState {
  startupComplete: boolean;
  ready: boolean;
  live: boolean;
  shouldThrowReady?: boolean;
  composite?: () => Promise<unknown>;
}

function buildApp(state: ProbeState): Express {
  const deps: HealthRouteDeps = {
    isStartupComplete: () => state.startupComplete,
    isLive: () => state.live,
    isReady: async () => {
      if (state.shouldThrowReady) {
        throw new Error('boom');
      }
      return state.ready;
    },
    ...(state.composite !== undefined ? { composite: state.composite } : {}),
  };

  const app = express();
  app.use(createHealthRoutes(deps));
  return app;
}

describe('createHealthRoutes', () => {
  describe('GET /health/live', () => {
    it('returns 200 with status "live" when isLive() is true', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'live' });
    });

    it('returns 503 with status "shutting-down" when isLive() is false', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: false,
      });

      const res = await request(app).get('/health/live');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'shutting-down' });
    });
  });

  describe('GET /health/startup', () => {
    it('returns 200 with status "started" once startup is complete', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health/startup');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'started' });
    });

    it('returns 503 with status "starting" before startup completes', async () => {
      const app = buildApp({
        startupComplete: false,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health/startup');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'starting' });
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when startup is complete and isReady() resolves true', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });

    it('returns 503 with reason "starting" before startup is complete', async () => {
      const app = buildApp({
        startupComplete: false,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'not-ready', reason: 'starting' });
    });

    it('returns 503 when isReady() resolves false (e.g. shutting down)', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: false,
        live: true,
      });

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not-ready');
    });

    it('returns 503 when isReady() throws (probe must not crash)', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
        shouldThrowReady: true,
      });

      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not-ready');
    });
  });

  describe('GET /health (composite)', () => {
    it('returns the composite payload when one is provided', async () => {
      const payload = { status: 'healthy', services: { mongo: 'ok' } };
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
        composite: async () => payload,
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
    });

    it('returns 503 with an error envelope when composite throws', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
        composite: async () => {
          throw new Error('downstream blew up');
        },
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.error).toBe('downstream blew up');
    });

    it('falls back to a simple status when no composite is provided', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: true,
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });

    it('reports unhealthy in the fallback when shutting down', async () => {
      const app = buildApp({
        startupComplete: true,
        ready: true,
        live: false,
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });
  });
});
