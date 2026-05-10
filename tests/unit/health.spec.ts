import express, { Express } from 'express';
import request from 'supertest';
import {
  createHealthRoutes,
  HealthRouteDeps,
} from '../../src/routes/health.routes';
import { pingWithTimeout } from '../../src/database/shared-redis';
import type { SharedRedisClient } from '../../src/database/shared-redis';

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

// ---------------------------------------------------------------------------
// Wave 3: dependency-aware readiness probe (Mongo + Redis)
// ---------------------------------------------------------------------------
//
// Mirrors the `isReady` body wired into `src/app.ts` so the integration of
// `mongoose.connection.readyState` + `pingWithTimeout(redisClient)` is
// exercised end-to-end without requiring a real Mongo or Redis. We inject
// stubs that mimic just enough of each surface for the probe to read.

interface DependencyStubs {
  mongoReadyState: 0 | 1 | 2 | 3;
  redisPingBehaviour: 'pong' | 'reject' | 'timeout';
  startupComplete?: boolean;
  shuttingDown?: boolean;
}

function buildAppWithDeps(stubs: DependencyStubs): Express {
  const startupComplete = stubs.startupComplete ?? true;
  const shuttingDown = stubs.shuttingDown ?? false;

  // Minimal stub Redis. Only `ping()` is consulted by `pingWithTimeout`.
  const stubRedis = {
    ping: async (): Promise<string> => {
      switch (stubs.redisPingBehaviour) {
        case 'pong':
          return 'PONG';
        case 'reject':
          throw new Error('redis offline');
        case 'timeout':
          // Resolve well past the probe's 200ms ceiling so the timeout
          // path fires deterministically. `.unref()` so the timer can't
          // hold Jest's worker process open after the test resolves.
          return new Promise<string>(resolve => {
            const t = setTimeout(() => resolve('PONG'), 1000);
            t.unref();
          });
      }
    },
  } as unknown as SharedRedisClient;

  const deps: HealthRouteDeps = {
    isStartupComplete: () => startupComplete,
    isLive: () => !shuttingDown,
    isReady: async () => {
      if (!startupComplete || shuttingDown) return false;
      if (stubs.mongoReadyState !== 1) return false;
      return pingWithTimeout(stubRedis, 50);
    },
  };

  const app = express();
  app.use(createHealthRoutes(deps));
  return app;
}

describe('createHealthRoutes — Mongo + Redis dependency probe', () => {
  it('returns 200 when Mongo is connected (readyState=1) and Redis PINGs OK', async () => {
    const app = buildAppWithDeps({
      mongoReadyState: 1,
      redisPingBehaviour: 'pong',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('returns 503 when Mongo is disconnected (readyState=0)', async () => {
    const app = buildAppWithDeps({
      mongoReadyState: 0,
      redisPingBehaviour: 'pong',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
  });

  it('returns 503 when Redis PING rejects', async () => {
    const app = buildAppWithDeps({
      mongoReadyState: 1,
      redisPingBehaviour: 'reject',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
  });

  it('returns 503 when Redis PING times out', async () => {
    const app = buildAppWithDeps({
      mongoReadyState: 1,
      redisPingBehaviour: 'timeout',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
  });

  it('returns 503 when both Mongo is down AND Redis is unreachable', async () => {
    const app = buildAppWithDeps({
      mongoReadyState: 0,
      redisPingBehaviour: 'reject',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
  });

  it('returns 503 with reason "starting" before startup completes (deps not consulted)', async () => {
    const app = buildAppWithDeps({
      startupComplete: false,
      mongoReadyState: 1,
      redisPingBehaviour: 'pong',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not-ready', reason: 'starting' });
  });

  it('returns 503 once shutdown has been signalled even if deps look healthy', async () => {
    const app = buildAppWithDeps({
      shuttingDown: true,
      mongoReadyState: 1,
      redisPingBehaviour: 'pong',
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
  });
});
