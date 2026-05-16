// ADR-0024 unit tests for `securityHeadersMiddleware()` + `nonceMiddleware()`.
//
// We drive the middleware against a real Express app via supertest so
// we exercise the actual helmet integration end-to-end (response
// headers, CSP nonce wiring, env toggles). The tests are deliberately
// hermetic — no network, no Redis — and stub the logger so warnings
// from the surrounding code don't leak into the suite output.

import express from 'express';
import request from 'supertest';
import {
  nonceMiddleware,
  securityHeadersMiddleware,
} from '../../../src/middleware/security-headers.middleware';

function buildApp(overrides?: Parameters<typeof securityHeadersMiddleware>[0]) {
  const app = express();
  app.use(nonceMiddleware());
  app.use(securityHeadersMiddleware(overrides));
  app.get('/x', (_req, res) => {
    // Echo the nonce so tests can assert it's reachable.
    res.json({ nonce: res.locals['cspNonce'] });
  });
  return app;
}

describe('securityHeadersMiddleware()', () => {
  describe('default policy (all toggles on)', () => {
    const app = buildApp();

    it('emits Strict-Transport-Security with 1-year max-age + includeSubDomains + preload', async () => {
      const res = await request(app).get('/x');
      expect(res.status).toBe(200);
      const hsts = res.headers['strict-transport-security'];
      expect(hsts).toBeDefined();
      expect(hsts).toMatch(/max-age=31536000/);
      expect(hsts).toMatch(/includeSubDomains/);
      expect(hsts).toMatch(/preload/);
    });

    it('emits Content-Security-Policy with the explicit ADR-0024 directives', async () => {
      const res = await request(app).get('/x');
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/script-src [^;]*'self'/);
      expect(csp).toMatch(/script-src [^;]*'strict-dynamic'/);
      expect(csp).toMatch(/style-src [^;]*'self'/);
      expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
      expect(csp).toMatch(/img-src [^;]*'self'/);
      expect(csp).toMatch(/img-src [^;]*data:/);
      expect(csp).toMatch(/img-src [^;]*https:/);
      expect(csp).toMatch(/connect-src [^;]*'self'/);
      expect(csp).toMatch(/connect-src [^;]*https:\/\/api\.anthropic\.com/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/base-uri 'self'/);
    });

    it('emits Referrer-Policy: no-referrer', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('emits Cross-Origin-Opener-Policy: same-origin', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    });

    it('emits Cross-Origin-Resource-Policy: same-site', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    });

    it('does NOT emit Cross-Origin-Embedder-Policy (dashboard pulls cross-origin fonts)', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    });

    it('emits X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('emits X-Frame-Options: DENY', async () => {
      const res = await request(app).get('/x');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });

  describe('env toggles', () => {
    it('omits HSTS when enableHSTS=false', async () => {
      const app = buildApp({ headers: { enableHSTS: false } });
      const res = await request(app).get('/x');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('omits CSP when enableCSP=false', async () => {
      const app = buildApp({ headers: { enableCSP: false } });
      const res = await request(app).get('/x');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('omits X-Frame-Options when enableXFrameOptions=false', async () => {
      const app = buildApp({ headers: { enableXFrameOptions: false } });
      const res = await request(app).get('/x');
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('omits X-Content-Type-Options when enableXContentType=false', async () => {
      const app = buildApp({ headers: { enableXContentType: false } });
      const res = await request(app).get('/x');
      expect(res.headers['x-content-type-options']).toBeUndefined();
    });

    it('respects custom HSTS max-age / includeSubDomains / preload', async () => {
      const app = buildApp({
        headers: {
          hstsMaxAge: 60,
          hstsIncludeSubDomains: false,
          hstsPreload: false,
        },
      });
      const res = await request(app).get('/x');
      const hsts = res.headers['strict-transport-security'];
      expect(hsts).toBe('max-age=60');
    });
  });

  describe('CSP nonce wiring', () => {
    const app = buildApp();

    it('exposes a base64url nonce on res.locals.cspNonce', async () => {
      const res = await request(app).get('/x');
      expect(typeof res.body.nonce).toBe('string');
      // base64url uses [A-Za-z0-9_-], no padding. 16 bytes → 22 chars.
      expect(res.body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('embeds the per-request nonce in the script-src directive', async () => {
      const res = await request(app).get('/x');
      const csp = res.headers['content-security-policy'];
      expect(csp).toContain(`'nonce-${res.body.nonce}'`);
    });

    it('emits a different nonce on every request', async () => {
      const a = await request(app).get('/x');
      const b = await request(app).get('/x');
      const c = await request(app).get('/x');
      expect(a.body.nonce).not.toEqual(b.body.nonce);
      expect(b.body.nonce).not.toEqual(c.body.nonce);
      expect(a.body.nonce).not.toEqual(c.body.nonce);
    });

    it("does not include a stale nonce literal '${nonce}' in the header", async () => {
      const res = await request(app).get('/x');
      const csp = res.headers['content-security-policy'];
      // Catch the templating bug where the literal `${nonce}` would
      // leak into the policy if helmet was given a string-interpolated
      // directive built before request time.
      expect(csp).not.toContain('${nonce}');
      expect(csp).not.toContain("'nonce-'");
    });
  });

  describe('connect-src override', () => {
    it('appends additional connect-src hosts when supplied', async () => {
      const app = buildApp({
        connectSrc: ['https://example.com', 'wss://stream.example.com'],
      });
      const res = await request(app).get('/x');
      const csp = res.headers['content-security-policy'];
      expect(csp).toMatch(/connect-src [^;]*https:\/\/example\.com/);
      expect(csp).toMatch(/connect-src [^;]*wss:\/\/stream\.example\.com/);
    });
  });

  describe('nonceMiddleware()', () => {
    it('populates res.locals.cspNonce even without securityHeadersMiddleware', async () => {
      const app = express();
      app.use(nonceMiddleware());
      app.get('/n', (_req, res) => {
        res.json({ nonce: res.locals['cspNonce'] });
      });
      const res = await request(app).get('/n');
      expect(typeof res.body.nonce).toBe('string');
      expect(res.body.nonce.length).toBeGreaterThan(0);
    });
  });
});
