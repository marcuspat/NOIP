// Unit tests for the kid-aware JWTManager: signing, verification, kid
// rotation, and the passwordChangedAt invariant. No Redis is configured
// here — these tests focus on the cryptographic + key-set behaviour.

import { JWTManager } from '../../../src/utils/auth/jwt.manager';

const baseClaims = {
  sub: 'user-1',
  username: 'u',
  email: 'u@example.com',
  roles: ['user'],
  permissions: ['user:read'],
  sessionId: 'sess-1',
};

function makeManager(
  opts: Partial<ConstructorParameters<typeof JWTManager>[0]> = {}
) {
  return new JWTManager({
    activeKey: {
      kid: 'kid-A',
      secret: 'a-secret-of-sufficient-length-for-hs256-32!',
    },
    issuer: 'NOIP Platform',
    audience: 'noip-client',
    accessExpirySec: 60,
    refreshExpirySec: 600,
    ...opts,
  });
}

describe('JWTManager', () => {
  it('roundtrips an access token (sign then verify)', async () => {
    const m = makeManager();
    const token = await m.signToken(baseClaims, 'access');
    const verified = await m.verifyToken(token, 'access');
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('user-1');
    expect(verified?.type).toBe('access');
  });

  it('roundtrips a refresh token and mints a family', async () => {
    const m = makeManager();
    const token = await m.signToken(baseClaims, 'refresh');
    const verified = await m.verifyToken(token, 'refresh');
    expect(verified).not.toBeNull();
    expect(verified?.type).toBe('refresh');
    const decoded = await m.decodeToken(token);
    expect((decoded as unknown as { family?: string })?.family).toMatch(
      /^[0-9a-f-]{36}$/i
    );
  });

  it('rejects a token of the wrong type', async () => {
    const m = makeManager();
    const access = await m.signToken(baseClaims, 'access');
    expect(await m.verifyToken(access, 'refresh')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const m = makeManager({ accessExpirySec: 1 });
    const token = await m.signToken(baseClaims, 'access');
    // Wait past the 1s exp + the small jose clock-skew tolerance.
    await new Promise(r => setTimeout(r, 1100));
    const v = await m.verifyToken(token, 'access');
    expect(v).toBeNull();
  });

  it('rejects a token signed by a kid no longer in the verifier set', async () => {
    const oldM = makeManager({
      activeKey: {
        kid: 'kid-OLD',
        secret: 'old-secret-which-is-also-32-chars-min!!!',
      },
    });
    const token = await oldM.signToken(baseClaims, 'access');

    // Build a brand-new manager that has never seen `kid-OLD` — its
    // verification should reject with `null`.
    const m = makeManager();
    expect(await m.verifyToken(token, 'access')).toBeNull();
  });

  it('keeps verifying tokens signed by the prior kid during a rotation window', async () => {
    const m = makeManager();
    const oldToken = await m.signToken(baseClaims, 'access');
    expect(await m.verifyToken(oldToken, 'access')).not.toBeNull();

    m.rotateKey({
      kid: 'kid-B',
      secret: 'second-secret-also-at-least-32-chars-long!',
    });
    expect(m.getActiveKid()).toBe('kid-B');

    // Tokens signed by the previous active kid still verify because the
    // prior kid is kept in the verifier set for the rotation window.
    expect(await m.verifyToken(oldToken, 'access')).not.toBeNull();

    // New tokens are signed under the new kid.
    const newToken = await m.signToken(baseClaims, 'access');
    expect(await m.verifyToken(newToken, 'access')).not.toBeNull();
  });

  it('drops a prior kid after the configured TTL elapses', async () => {
    const m = makeManager({ priorKidTtlMs: 5 });
    const token = await m.signToken(baseClaims, 'access');
    m.rotateKey({
      kid: 'kid-B',
      secret: 'second-secret-also-at-least-32-chars-long!',
    });

    // Wait past the prior-kid window.
    await new Promise(r => setTimeout(r, 15));
    expect(await m.verifyToken(token, 'access')).toBeNull();
  });

  it('rejects when passwordChangedAt is after token iat', async () => {
    const future = new Date(Date.now() + 10_000);
    const m = makeManager({
      passwordChangedAtLoader: async () => future,
    });
    const token = await m.signToken(baseClaims, 'access');
    expect(await m.verifyToken(token, 'access')).toBeNull();
  });

  it('accepts when passwordChangedAt is before token iat', async () => {
    const past = new Date(Date.now() - 60_000);
    const m = makeManager({
      passwordChangedAtLoader: async () => past,
    });
    const token = await m.signToken(baseClaims, 'access');
    expect(await m.verifyToken(token, 'access')).not.toBeNull();
  });

  it('rejects when iss/aud do not match', async () => {
    const a = makeManager({ issuer: 'Issuer-A' });
    const b = makeManager({ issuer: 'Issuer-B' });
    const token = await a.signToken(baseClaims, 'access');
    expect(await b.verifyToken(token, 'access')).toBeNull();
  });
});
