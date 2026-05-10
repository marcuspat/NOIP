// Unit tests for the Redis-backed denylist: revoke → isRevoked, TTL
// alignment with token lifetime, idempotency, and graceful handling of
// transient Redis failures.

import { JWTManager } from '../../../src/utils/auth/jwt.manager';
import { FakeRedis } from './_redis-stub';

const claims = {
  sub: 'user-1',
  username: 'u',
  email: 'u@example.com',
  roles: ['user'],
  permissions: ['user:read'],
  sessionId: 'sess-1',
};

function makeManager(redis: FakeRedis, accessExpirySec = 600) {
  return new JWTManager({
    activeKey: {
      kid: 'kid-A',
      secret: 'denylist-test-secret-min-32-chars-long-pad!',
    },
    accessExpirySec,
    refreshExpirySec: 7 * 24 * 3600,
    redis,
  });
}

describe('JWTManager.revokeToken / isTokenRevoked', () => {
  it('marks a freshly-issued token as revoked once revokeToken is called', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const token = await m.signToken(claims, 'access');

    expect(await m.isTokenRevoked(token)).toBe(false);
    await m.revokeToken(token, 'unit-test');
    expect(await m.isTokenRevoked(token)).toBe(true);
  });

  it('honours the token residual lifetime as the Redis TTL', async () => {
    const r = new FakeRedis();
    const m = makeManager(r, 120);
    const token = await m.signToken(claims, 'access');
    await m.revokeToken(token, 'unit-test');

    const decoded = await m.decodeToken(token);
    const jti = (decoded as unknown as { jti?: string }).jti!;
    const ttlSec = r.ttl(`noip:deny:${jti}`);

    // TTL is bounded above by the access lifetime and strictly positive.
    expect(ttlSec).toBeGreaterThan(0);
    expect(ttlSec).toBeLessThanOrEqual(120);
  });

  it('is idempotent: revoking the same token twice keeps it revoked', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const token = await m.signToken(claims, 'access');

    await m.revokeToken(token);
    await m.revokeToken(token);
    expect(await m.isTokenRevoked(token)).toBe(true);
  });

  it('verifyToken rejects denylisted tokens', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const token = await m.signToken(claims, 'access');
    await m.revokeToken(token);
    expect(await m.verifyToken(token, 'access')).toBeNull();
  });

  it('survives a transient Redis blip (one failure then success)', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const token = await m.signToken(claims, 'access');

    // First setEx fails; the manager logs and swallows the error so a
    // logout can return cleanly. The token is then *not* on the
    // denylist — but a subsequent revoke succeeds.
    r.failNext(1);
    await m.revokeToken(token); // swallowed

    // Re-revoke after Redis recovers.
    await m.revokeToken(token);
    expect(await m.isTokenRevoked(token)).toBe(true);
  });

  it('fails closed when Redis is unreachable during verification', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const token = await m.signToken(claims, 'access');

    r.failNext(1);
    // Failed MGET during verify → reject as if denylisted (ADR-0016).
    expect(await m.verifyToken(token, 'access')).toBeNull();
  });
});
