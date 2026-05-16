// ADR-0024 unit tests for the `corsAllowList()` factory.
//
// We drive the middleware against a real Express app via supertest so
// we exercise the actual `cors` integration end-to-end (allow/refuse
// semantics, credentials enforcement, Vary header, preflight cache).

import express from 'express';
import request from 'supertest';
import { corsAllowList } from '../../../src/middleware/cors.middleware';

interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function makeLogger() {
  const events: CapturedLog[] = [];
  return {
    events,
    info: (m: string, meta?: Record<string, unknown>) =>
      events.push(
        meta
          ? { level: 'info', message: m, meta }
          : { level: 'info', message: m }
      ),
    warn: (m: string, meta?: Record<string, unknown>) =>
      events.push(
        meta
          ? { level: 'warn', message: m, meta }
          : { level: 'warn', message: m }
      ),
    error: (m: string, meta?: Record<string, unknown>) =>
      events.push(
        meta
          ? { level: 'error', message: m, meta }
          : { level: 'error', message: m }
      ),
  };
}

function buildApp(
  origins: readonly string[],
  opts?: Parameters<typeof corsAllowList>[1]
) {
  const app = express();
  app.use(corsAllowList(origins, opts));
  app.get('/r', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/r', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('corsAllowList()', () => {
  describe('allow-list enforcement', () => {
    const app = buildApp(
      ['https://app.example.com', 'https://admin.example.com'],
      {
        environment: 'production',
      }
    );

    it('permits a request from an allow-listed origin and echoes it back', async () => {
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://app.example.com'
      );
    });

    it('permits a second allow-listed origin', async () => {
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://admin.example.com');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://admin.example.com'
      );
    });

    it('does NOT echo back an origin that is not in the allow-list', async () => {
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://evil.example.com');
      // The request still completes (the cors lib does not 4xx it);
      // the browser enforces the policy on the response. We assert
      // that no Allow-Origin header is emitted.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does NOT emit Allow-Origin when no Origin header is present', async () => {
      const res = await request(app).get('/r');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('matches origins exactly (no substring/suffix matching)', async () => {
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com.evil.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('treats scheme + host + port as part of the match', async () => {
      const res = await request(app)
        .get('/r')
        .set('Origin', 'http://app.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('credentials policy', () => {
    it('emits Allow-Credentials: true when credentials=true AND origin allow-listed', async () => {
      const app = buildApp(['https://app.example.com'], {
        credentials: true,
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://app.example.com'
      );
    });

    it('omits Allow-Credentials when credentials=false', async () => {
      const app = buildApp(['https://app.example.com'], {
        credentials: false,
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('does NOT emit Allow-Credentials for a refused origin even when credentials=true', async () => {
      const app = buildApp(['https://app.example.com'], {
        credentials: true,
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('refuses the credentials+* combination (forces credentials off, logs an error)', async () => {
      const log = makeLogger();
      const app = buildApp(['*'], {
        credentials: true,
        environment: 'production',
        log,
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://anywhere.example.com');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      const errored = log.events.some(
        e =>
          e.level === 'error' &&
          e.message.includes('credentials=true') &&
          e.message.includes('"*"')
      );
      expect(errored).toBe(true);
    });
  });

  describe('preflight (OPTIONS)', () => {
    const app = buildApp(['https://app.example.com'], {
      credentials: true,
      maxAge: 600,
      environment: 'production',
    });

    it('responds 204 to a valid preflight from an allow-listed origin', async () => {
      const res = await request(app)
        .options('/r')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://app.example.com'
      );
    });

    it('emits Access-Control-Max-Age: 600 by default', async () => {
      const res = await request(app)
        .options('/r')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('honours a custom maxAge override', async () => {
      const app2 = buildApp(['https://app.example.com'], {
        maxAge: 120,
        environment: 'production',
      });
      const res = await request(app2)
        .options('/r')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-max-age']).toBe('120');
    });
  });

  describe('Vary header', () => {
    it('sets Vary: Origin on an allowed-origin response', async () => {
      const app = buildApp(['https://app.example.com'], {
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com');
      expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    });

    it('sets Vary: Origin even when the origin is refused', async () => {
      const app = buildApp(['https://app.example.com'], {
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    });

    it('sets Vary: Origin even when no Origin header is sent', async () => {
      const app = buildApp(['https://app.example.com'], {
        environment: 'production',
      });
      const res = await request(app).get('/r');
      expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    });

    it('does not duplicate Origin in Vary when upstream already set it', async () => {
      const app = express();
      app.use((_req, res, next) => {
        res.setHeader('Vary', 'Accept-Encoding, Origin');
        next();
      });
      app.use(
        corsAllowList(['https://app.example.com'], {
          environment: 'production',
        })
      );
      app.get('/r', (_req, res) => res.json({ ok: true }));
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://app.example.com');
      const vary = res.headers['vary'];
      const occurrences = (vary?.match(/Origin/gi) ?? []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('dev/test fallback when CORS_ORIGINS is unset or "*"', () => {
    it('falls back to localhost defaults and logs a warning in development', async () => {
      const log = makeLogger();
      const app = buildApp([], { environment: 'development', log });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
      const warned = log.events.some(
        e =>
          e.level === 'warn' &&
          e.message.includes('CORS_ORIGINS') &&
          e.message.includes('localhost')
      );
      expect(warned).toBe(true);
    });

    it('also falls back when the list is just ["*"] in test environment', async () => {
      const log = makeLogger();
      const app = buildApp(['*'], { environment: 'test', log });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
      const warned = log.events.some(e => e.level === 'warn');
      expect(warned).toBe(true);
    });

    it('does NOT fall back when the operator supplied real origins in dev', async () => {
      const log = makeLogger();
      const app = buildApp(['https://dev.example.com'], {
        environment: 'development',
        log,
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'http://localhost:3000');
      // Localhost is NOT in the explicit list → not echoed.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // No warning about falling back.
      const warned = log.events.some(e => e.level === 'warn');
      expect(warned).toBe(false);
    });

    it('does NOT fall back in production even when the list is empty', async () => {
      const log = makeLogger();
      const app = buildApp([], { environment: 'production', log });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // Should not warn the dev-only fallback message.
      const fallbackWarn = log.events.some(
        e => e.level === 'warn' && e.message.includes('localhost defaults')
      );
      expect(fallbackWarn).toBe(false);
    });
  });

  describe('wildcard handling (non-credentialed)', () => {
    it('echoes "*" when allow-list contains "*" and credentials are off', async () => {
      const app = buildApp(['*'], {
        credentials: false,
        environment: 'production',
      });
      const res = await request(app)
        .get('/r')
        .set('Origin', 'https://random.example.com');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });
});
