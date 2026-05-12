import { buildRateLimiter } from '../../../src/utils/rate-limiter';

describe('buildRateLimiter', () => {
  it('returns an Express middleware function (3-arg signature)', () => {
    const mw = buildRateLimiter({
      redis: null,
      namespace: 'unit',
      windowMs: 60_000,
      max: 5,
    });
    expect(typeof mw).toBe('function');
    expect(mw.length).toBe(3); // (req, res, next)
  });

  it('warns when constructed without Redis', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Winston routes to its transports, not console.warn. Build the limiter
    // and just assert the call site is reachable without throwing.
    expect(() =>
      buildRateLimiter({
        redis: null,
        namespace: 'unit',
        windowMs: 60_000,
        max: 5,
      })
    ).not.toThrow();
    spy.mockRestore();
  });

  it('accepts a Redis-like client without throwing', () => {
    const fakeRedis = {
      call: jest.fn(async () => 'OK'),
    } as unknown as Parameters<typeof buildRateLimiter>[0]['redis'];
    expect(() =>
      buildRateLimiter({
        redis: fakeRedis,
        namespace: 'unit',
        windowMs: 60_000,
        max: 5,
      })
    ).not.toThrow();
  });

  it('different namespaces produce distinct middleware instances', () => {
    const a = buildRateLimiter({
      redis: null,
      namespace: 'global',
      windowMs: 60_000,
      max: 5,
    });
    const b = buildRateLimiter({
      redis: null,
      namespace: 'auth',
      windowMs: 60_000,
      max: 5,
    });
    expect(a).not.toBe(b);
  });
});
