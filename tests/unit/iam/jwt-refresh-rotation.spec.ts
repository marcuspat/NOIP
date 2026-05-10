// Unit tests for refresh-token rotation and theft detection.

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

function makeManager(redis: FakeRedis) {
  return new JWTManager({
    activeKey: {
      kid: 'kid-A',
      secret: 'rotation-test-secret-min-32-chars-long-pad!',
    },
    accessExpirySec: 60,
    refreshExpirySec: 600,
    redis,
  });
}

async function familyOf(m: JWTManager, token: string): Promise<string> {
  const decoded = await m.decodeToken(token);
  return (decoded as unknown as { family: string }).family;
}

async function jtiOf(m: JWTManager, token: string): Promise<string> {
  const decoded = await m.decodeToken(token);
  return (decoded as unknown as { jti: string }).jti;
}

describe('JWTManager refresh rotation', () => {
  it('rotates: returns a new pair under the same family and denylists the old refresh', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const initial = await m.createTokenPair(claims);
    const fam0 = initial.family;
    expect(await familyOf(m, initial.refreshToken)).toBe(fam0);

    const rotated = await m.refreshToken(initial.refreshToken);
    expect(rotated).not.toBeNull();
    expect(rotated!.family).toBe(fam0);
    expect(await familyOf(m, rotated!.refreshToken)).toBe(fam0);
    expect(rotated!.refreshToken).not.toBe(initial.refreshToken);

    // Old refresh now denylisted.
    const oldJti = await jtiOf(m, initial.refreshToken);
    expect(r.raw(`noip:deny:${oldJti}`)).toBeDefined();

    // The new refresh still verifies.
    expect(
      await m.verifyToken(rotated!.refreshToken, 'refresh')
    ).not.toBeNull();
  });

  it('marks the family compromised when a denylisted refresh is replayed', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const initial = await m.createTokenPair(claims);

    // First rotate normally — old refresh is denylisted, new pair issued.
    const firstRotation = await m.refreshToken(initial.refreshToken);
    expect(firstRotation).not.toBeNull();

    // Replay the now-denylisted refresh: family must be marked compromised.
    const replay = await m.refreshToken(initial.refreshToken);
    expect(replay).toBeNull();

    const famKey = `noip:fam:${initial.family}`;
    const fam = JSON.parse(r.raw(famKey)!) as { status: string };
    expect(fam.status).toBe('compromised');
  });

  it('rejects access tokens that belong to a compromised family', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const initial = await m.createTokenPair(claims);

    // Brand-new access verifies cleanly.
    expect(await m.verifyToken(initial.accessToken, 'access')).not.toBeNull();

    // Compromise the family (simulating refresh-replay detection).
    await m.markFamilyCompromised(initial.family, 'refresh-replay');

    // Even the legitimate access token now fails verification.
    expect(await m.verifyToken(initial.accessToken, 'access')).toBeNull();
  });

  it('rejects tokens in a revoked family (logout flow)', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const initial = await m.createTokenPair(claims);

    await m.markFamilyRevoked(initial.family, 'logout');

    expect(await m.verifyToken(initial.accessToken, 'access')).toBeNull();
    expect(await m.verifyToken(initial.refreshToken, 'refresh')).toBeNull();
  });

  it('refresh path verifies once per call (no double-verify cost)', async () => {
    const r = new FakeRedis();
    const m = makeManager(r);
    const initial = await m.createTokenPair(claims);

    // We don't have a hook to spy on jwtVerify — but if `refreshToken`
    // succeeded with only one denylist pre-check (one GET) and one
    // family-state read (one MGET inside verify), we should observe
    // exactly two reads against Redis. With double-verify it would be
    // three or more. Wrap mget/get to count.
    let getCalls = 0;
    let mgetCalls = 0;
    const orig = { get: r.get.bind(r), mget: r.mget.bind(r) };
    r.get = async (k: string) => {
      getCalls += 1;
      return orig.get(k);
    };
    r.mget = async (ks: string[]) => {
      mgetCalls += 1;
      return orig.mget(ks);
    };

    const rotated = await m.refreshToken(initial.refreshToken);
    expect(rotated).not.toBeNull();
    expect(getCalls).toBe(1);
    expect(mgetCalls).toBe(1);
  });
});
