// Verifies the auth router mounts per-bucket limiters (ADR-0016) and
// that each bucket carries the expected window / max / failure-mode
// shape from the spec. The router is built with a stub limiter factory
// so the test does not depend on a real Redis or
// `express-rate-limit`'s internals.

import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';

import {
  createAuthRouter,
  AUTH_LIMITER_WINDOWS,
  type AuthLimiterFactory,
} from '../../../src/routes/auth.routes';
import type { AuthService } from '../../../src/services/auth.service';
import type { BucketLimiterOptions } from '../../../src/middleware/rate-limit-redis';

// Silence the production logger so test output stays focused.
jest.mock('../../../src/utils/logger', () => {
  const noop = (): void => {};
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

// AuthMiddleware does I/O (Mongo + Redis) on real auth — stub the
// authenticate / requireRole pipelines so we can hit the public routes
// (which are what the bucket limiters protect).
jest.mock('../../../src/middleware/auth.middleware', () => {
  return {
    AuthMiddleware: class {
      authenticate = (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction
      ): void => next();
      requireRole =
        () =>
        (
          _req: express.Request,
          _res: express.Response,
          next: express.NextFunction
        ): void =>
          next();
    },
  };
});

// Audit middleware writes domain events; not relevant here.
jest.mock('../../../src/middleware/audit.middleware', () => {
  return {
    AuditMiddleware: class {
      auditUserAction =
        (): RequestHandler =>
        (_req, _res, next): void =>
          next();
    },
    auditMiddleware:
      (): RequestHandler =>
      (_req, _res, next): void =>
        next(),
  };
});

interface CapturedLimiter {
  bucket: BucketLimiterOptions['bucket'];
  options: BucketLimiterOptions;
  hits: number;
}

function buildHarness(maxBeforeBlock: number): {
  app: express.Express;
  captured: CapturedLimiter[];
} {
  const captured: CapturedLimiter[] = [];

  const limiterFactory: AuthLimiterFactory = opts => {
    const entry: CapturedLimiter = {
      bucket: opts.bucket,
      options: { ...opts },
      hits: 0,
    };
    captured.push(entry);
    return (_req, res, next): void => {
      entry.hits += 1;
      if (entry.hits > maxBeforeBlock) {
        res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          bucket: `bucket.${opts.bucket}`,
        });
        return;
      }
      next();
    };
  };

  // We never actually call into AuthService methods because the
  // controller is mocked below. A bare object cast is fine.
  const authService = {
    register: async (): Promise<unknown> => ({}),
    login: async (): Promise<unknown> => ({}),
    refreshToken: async (): Promise<unknown> => ({}),
    requestPasswordReset: async (): Promise<void> => undefined,
    confirmPasswordReset: async (): Promise<void> => undefined,
    setupMFA: async (): Promise<unknown> => ({}),
    verifyMFA: async (): Promise<boolean> => true,
    healthCheck: async (): Promise<unknown> => ({ status: 'ok' }),
  } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/auth',
    createAuthRouter({
      authService,
      limiterFactory,
    })
  );
  return { app, captured };
}

describe('createAuthRouter — per-bucket limiters (ADR-0016)', () => {
  it('mounts auth / password-reset / mfa limiters with the configured windows', () => {
    const { captured } = buildHarness(100);

    const byBucket = new Map<string, CapturedLimiter>();
    for (const c of captured) byBucket.set(c.bucket, c);

    expect(byBucket.has('auth')).toBe(true);
    expect(byBucket.has('password-reset')).toBe(true);
    expect(byBucket.has('mfa')).toBe(true);
    expect(byBucket.has('general')).toBe(false);

    expect(byBucket.get('auth')!.options).toMatchObject(
      AUTH_LIMITER_WINDOWS.auth
    );
    expect(byBucket.get('password-reset')!.options).toMatchObject(
      AUTH_LIMITER_WINDOWS['password-reset']
    );
    expect(byBucket.get('mfa')!.options).toMatchObject(
      AUTH_LIMITER_WINDOWS.mfa
    );
  });

  it('returns 429 on the N+1th POST /login when the auth bucket is exhausted', async () => {
    const N = 3;
    const { app, captured } = buildHarness(N);

    for (let i = 0; i < N; i += 1) {
      const ok = await request(app)
        .post('/api/auth/login')
        .send({ username: 'u', password: 'p' });
      expect(ok.status).not.toBe(429);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ username: 'u', password: 'p' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.bucket).toBe('bucket.auth');

    const authLimiter = captured.find(c => c.bucket === 'auth')!;
    expect(authLimiter.hits).toBe(N + 1);
  });

  it('shares the auth bucket across /login and /register but not with /mfa/verify', async () => {
    const N = 2;
    const { app, captured } = buildHarness(N);

    await request(app)
      .post('/api/auth/login')
      .send({ username: 'u', password: 'p' });
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'u', password: 'p' });

    const authLimiter = captured.find(c => c.bucket === 'auth')!;
    const mfaLimiter = captured.find(c => c.bucket === 'mfa')!;
    expect(authLimiter.hits).toBe(2);
    expect(mfaLimiter.hits).toBe(0);

    // MFA bucket is independent — hitting /mfa/verify increments only
    // the MFA limiter, not the auth one.
    await request(app)
      .post('/api/auth/mfa/verify')
      .send({ code: '123456', method: 'totp' });
    expect(authLimiter.hits).toBe(2);
    expect(mfaLimiter.hits).toBe(1);
  });

  it('throws when neither redisClient nor limiterFactory is supplied', () => {
    const authService = {} as unknown as AuthService;
    expect(() => {
      const router = createAuthRouter({ authService });
      // Touch the router so we know the factory ran but failed lazily.
      void router;
    }).toThrow(/redisClient is required/);
  });
});
