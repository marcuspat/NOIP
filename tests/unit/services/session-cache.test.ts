import { SessionCache, SessionState } from '../../../src/services/session-cache.service';

interface FakeRedis {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}

const mkRedis = (): FakeRedis => {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
};

const baseState: SessionState = {
  sessionId: 's1',
  userId: 'u1',
  active: true,
  refreshTokenJti: 'j1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('SessionCache', () => {
  it('is a no-op when no Redis is provided (get returns null, set/revoke do not throw)', async () => {
    const cache = new SessionCache({ redis: null });
    expect(await cache.get('s1')).toBeNull();
    await expect(cache.set(baseState)).resolves.toBeUndefined();
    await expect(cache.revoke('s1', 'logout')).resolves.toBeUndefined();
    await expect(cache.delete('s1')).resolves.toBeUndefined();
  });

  it('set + get round-trip preserves state', async () => {
    const redis = mkRedis();
    const cache = new SessionCache({ redis: redis as unknown as never });
    await cache.set(baseState);
    expect(redis.set).toHaveBeenCalled();
    const got = await cache.get('s1');
    expect(got).toEqual(baseState);
  });

  it('set uses TTL bounded by expiresAt', async () => {
    const redis = mkRedis();
    const cache = new SessionCache({ redis: redis as unknown as never });
    const futureSecs = Math.floor(Date.now() / 1000) + 30;
    await cache.set({ ...baseState, expiresAt: futureSecs });
    const args = redis.set.mock.calls[0];
    // Args: key, value, 'EX', seconds
    expect(args[2]).toBe('EX');
    const ttl = args[3] as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('revoke flips active to false and records reason', async () => {
    const redis = mkRedis();
    const cache = new SessionCache({ redis: redis as unknown as never });
    await cache.set(baseState);
    await cache.revoke('s1', 'logout');
    const got = await cache.get('s1');
    expect(got?.active).toBe(false);
    expect(got?.revokedReason).toBe('logout');
  });

  it('revoke on missing key is a no-op (does not write)', async () => {
    const redis = mkRedis();
    const cache = new SessionCache({ redis: redis as unknown as never });
    await cache.revoke('does-not-exist', 'logout');
    // No set call, only the initial get.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('falls open on Redis errors (set logs, does not throw)', async () => {
    const redis: FakeRedis = {
      get: jest.fn(async () => {
        throw new Error('network');
      }),
      set: jest.fn(async () => {
        throw new Error('network');
      }),
      del: jest.fn(async () => 0),
    };
    const cache = new SessionCache({ redis: redis as unknown as never });
    await expect(cache.set(baseState)).resolves.toBeUndefined();
    await expect(cache.get('s1')).resolves.toBeNull();
  });

  it('delete removes the key', async () => {
    const redis = mkRedis();
    const cache = new SessionCache({ redis: redis as unknown as never });
    await cache.set(baseState);
    await cache.delete('s1');
    expect(await cache.get('s1')).toBeNull();
  });
});
