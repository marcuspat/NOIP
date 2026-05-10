// Wave-3 spec for the Redis-backed rate limiter (ADR-0016).
//
// We don't spin a real Redis here. The tests drive the `wrapWithFailureMode`
// helper (the failure-mode contract) directly, and the per-bucket counter
// behaviour is exercised by stitching `express-rate-limit` into a one-shot
// stub `Store` that we drive synchronously from the test. This isolates the
// two things that actually need to be locked down:
//
//   1. Per-IP counter increments live in the store, not in process memory.
//      We assert that consecutive requests from the same IP land on the
//      same store key and that the limiter eventually issues a 429.
//
//   2. Failure-mode semantics:
//        - `general` bucket: fail-OPEN (request passes through, log emitted).
//        - `auth` bucket: fail-CLOSED (503 with structured body).
//
// Both knobs come from `wrapWithFailureMode`; we verify them by feeding a
// limiter that *always* throws into the wrapper.

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import rateLimit, {
  type Store,
  type IncrementResponse,
} from 'express-rate-limit';
import {
  wrapWithFailureMode,
  type RateLimitBucket,
} from '../../../src/middleware/rate-limit-redis';

interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function makeLogger(): {
  events: CapturedLog[];
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
} {
  const events: CapturedLog[] = [];
  return {
    events,
    info: (m, meta) =>
      events.push(
        meta
          ? { level: 'info', message: m, meta }
          : { level: 'info', message: m }
      ),
    warn: (m, meta) =>
      events.push(
        meta
          ? { level: 'warn', message: m, meta }
          : { level: 'warn', message: m }
      ),
    error: (m, meta) =>
      events.push(
        meta
          ? { level: 'error', message: m, meta }
          : { level: 'error', message: m }
      ),
  };
}

/**
 * Map-backed Store that mimics the contract `rate-limit-redis` exposes
 * to `express-rate-limit`: `increment(key)` returns `{ totalHits, resetTime }`
 * and counters live keyed by the key generator output (i.e. per IP).
 *
 * Used by the "per-IP increments" test below to prove the limiter consults
 * the store per request and surfaces 429s once the cap is hit.
 */
class MapStore implements Store {
  public readonly hits = new Map<string, number>();
  public readonly resetTimes = new Map<string, Date>();
  public windowMs = 60_000;

  init(opts: { windowMs: number }): void {
    this.windowMs = opts.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const next = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, next);
    const reset =
      this.resetTimes.get(key) ?? new Date(Date.now() + this.windowMs);
    this.resetTimes.set(key, reset);
    return { totalHits: next, resetTime: reset };
  }

  async decrement(key: string): Promise<void> {
    const v = this.hits.get(key) ?? 0;
    if (v > 0) this.hits.set(key, v - 1);
  }

  async resetKey(key: string): Promise<void> {
    this.hits.delete(key);
    this.resetTimes.delete(key);
  }
}

/**
 * Build an Express app with one limiter mounted on `/probe`. The limiter
 * uses the supplied store and a 2-request cap so we can hit the limit in
 * a couple of round-trips.
 */
function buildLimiterApp(store: Store, max: number): express.Express {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    // Static key so we don't depend on `req.ip` plumbing through supertest.
    keyGenerator: () => 'static-test-ip',
    // express-rate-limit v8 requires this to be set when keyGenerator is
    // overridden so it doesn't auto-fall-back to req.ip.
    validate: false,
  });

  const app = express();
  app.use('/probe', limiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('Redis-backed rate limiter — counter increments per IP', () => {
  it('increments a single store key per request and 429s once the cap is hit', async () => {
    const store = new MapStore();
    const app = buildLimiterApp(store, 2);

    const r1 = await request(app).get('/probe');
    const r2 = await request(app).get('/probe');
    const r3 = await request(app).get('/probe');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);

    // All three landed on the same store key — proving the counter is
    // shared (i.e. would be shared across pods in production).
    expect(store.hits.size).toBe(1);
    expect(store.hits.get('static-test-ip')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Failure-mode semantics: wrapWithFailureMode
// ---------------------------------------------------------------------------

/**
 * Build an Express app with a wrapped limiter that ALWAYS throws on
 * invocation, simulating a Redis outage during the store's `INCR`. We
 * use this to drive the `wrapWithFailureMode` paths.
 */
function buildFailingApp(bucket: RateLimitBucket): {
  app: express.Express;
  events: CapturedLog[];
} {
  const log = makeLogger();
  const failingLimiter = (
    _req: Request,
    _res: Response,
    next: (err?: unknown) => void
  ): void => {
    next(new Error('ECONNREFUSED 127.0.0.1:6379'));
  };
  const wrapped = wrapWithFailureMode(
    failingLimiter,
    bucket,
    log as unknown as Parameters<typeof wrapWithFailureMode>[2]
  );

  const app = express();
  app.use('/probe', wrapped, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return { app, events: log.events };
}

describe('Redis-backed rate limiter — failure modes (ADR-0016)', () => {
  it('fails OPEN for the general bucket: passes the request, logs the metric', async () => {
    const { app, events } = buildFailingApp('general');

    const res = await request(app).get('/probe');

    // Request reaches the route handler — fail-open.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Metric was emitted.
    const metric = events.find(
      e =>
        e.level === 'error' &&
        e.message === 'noip_rate_limit_redis_unavailable_total'
    );
    expect(metric).toBeDefined();
    expect(metric!.meta).toMatchObject({
      bucket: 'general',
      failClosed: false,
    });
  });

  it('fails OPEN for the AI bucket (cost-amplification limit; WAF backstop)', async () => {
    const { app, events } = buildFailingApp('ai');

    const res = await request(app).get('/probe');

    expect(res.status).toBe(200);
    expect(
      events.some(e => e.message === 'noip_rate_limit_redis_unavailable_total')
    ).toBe(true);
  });

  it('fails CLOSED for the auth bucket: 503 with a structured body, route never reached', async () => {
    const { app, events } = buildFailingApp('auth');

    const res = await request(app).get('/probe');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
      bucket: 'bucket.auth',
    });

    const metric = events.find(
      e => e.message === 'noip_rate_limit_redis_unavailable_total'
    );
    expect(metric).toBeDefined();
    expect(metric!.meta).toMatchObject({ bucket: 'auth', failClosed: true });
  });

  it('fails CLOSED for password-reset and MFA buckets', async () => {
    for (const bucket of ['password-reset', 'mfa'] as RateLimitBucket[]) {
      const { app } = buildFailingApp(bucket);
      const res = await request(app).get('/probe');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('RATE_LIMIT_BACKEND_UNAVAILABLE');
      expect(res.body.bucket).toBe(`bucket.${bucket}`);
    }
  });

  it('passes a normal request through when the limiter calls next() cleanly', async () => {
    // No-op limiter — never throws, just calls next(). Verifies the
    // wrapper does not introduce overhead on the happy path.
    const log = makeLogger();
    const wrapped = wrapWithFailureMode(
      (_req, _res, next) => next(),
      'general',
      log as unknown as Parameters<typeof wrapWithFailureMode>[2]
    );

    const app = express();
    app.use('/probe', wrapped, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    // No metric on the happy path.
    expect(
      log.events.filter(
        e => e.message === 'noip_rate_limit_redis_unavailable_total'
      )
    ).toHaveLength(0);
  });
});
