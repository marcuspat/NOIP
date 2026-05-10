// Unit tests for `RedisPermissionCache`.
//
// Coverage:
//   - get/set/invalidate happy path
//   - Redis failure swallowed; `get` returns null, `set`/`invalidate` log
//   - oversize set is rejected with an error log

import {
  MAX_PERMISSIONS_PER_USER,
  RedisPermissionCache,
  permissionCacheKey,
} from '../../../src/services/iam/permission-cache';
import type {
  EffectivePermissionSet,
  PermissionSpec,
} from '../../../src/services/iam/permission-resolver.service';
import { asInstant } from '../../../src/shared/kernel';
import { CapturingLogger, FakeCacheRedis } from './_iam-stubs';

function buildSet(
  userId: string,
  perms: PermissionSpec[]
): EffectivePermissionSet {
  const map = new Map<string, PermissionSpec>();
  for (const p of perms) map.set(`${p.resource}.${p.action}`, p);
  return {
    userId,
    permissions: map,
    computedAt: asInstant('2026-05-10T00:00:00.000Z'),
  };
}

const SAMPLE_PERM: PermissionSpec = {
  id: 'p-1',
  name: 'user.read',
  resource: 'user',
  action: 'read',
};

describe('RedisPermissionCache', () => {
  it('round-trips a set: set → get returns the same shape', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    const set = buildSet('u-1', [SAMPLE_PERM]);
    await cache.set('u-1', set);
    const round = await cache.get('u-1');

    expect(round).not.toBeNull();
    expect(round!.userId).toBe('u-1');
    expect(round!.permissions.size).toBe(1);
    expect(round!.permissions.get('user.read')).toEqual(SAMPLE_PERM);
    expect(round!.computedAt).toBe(set.computedAt);
  });

  it('uses the canonical key prefix', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    await cache.set('u-1', buildSet('u-1', [SAMPLE_PERM]));
    expect(redis.has('noip:cache:perm:u-1')).toBe(true);
    expect(permissionCacheKey('u-1')).toBe('noip:cache:perm:u-1');
  });

  it('returns null on miss', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });
    expect(await cache.get('nobody')).toBeNull();
  });

  it('invalidate removes the cached entry', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    await cache.set('u-1', buildSet('u-1', [SAMPLE_PERM]));
    expect(redis.has('noip:cache:perm:u-1')).toBe(true);

    await cache.invalidate('u-1');
    expect(redis.has('noip:cache:perm:u-1')).toBe(false);
  });

  it('invalidateAll drops every entry under the prefix', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    await cache.set('u-1', buildSet('u-1', [SAMPLE_PERM]));
    await cache.set('u-2', buildSet('u-2', [SAMPLE_PERM]));
    expect(redis.size()).toBe(2);

    await cache.invalidateAll();
    expect(redis.size()).toBe(0);
  });

  it('returns null on Redis GET failure (logged, not thrown)', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    redis.failNext(1);
    const result = await cache.get('u-1');
    expect(result).toBeNull();
    expect(logger.events.some(e => e.level === 'warn')).toBe(true);
  });

  it('swallows Redis SET failure (logged, not thrown)', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    redis.failNext(1);
    await expect(
      cache.set('u-1', buildSet('u-1', [SAMPLE_PERM]))
    ).resolves.toBeUndefined();
    expect(logger.events.some(e => e.level === 'warn')).toBe(true);
  });

  it('swallows Redis DEL failure (logged, not thrown)', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    redis.failNext(1);
    await expect(cache.invalidate('u-1')).resolves.toBeUndefined();
    expect(logger.events.some(e => e.level === 'warn')).toBe(true);
  });

  it('treats a corrupt cache payload as a miss', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    // Plant invalid JSON via the bypass path.
    await redis.setex(permissionCacheKey('u-corrupt'), 60, '{not-json');
    const result = await cache.get('u-corrupt');
    expect(result).toBeNull();
    expect(logger.events.some(e => e.level === 'warn')).toBe(true);
  });

  it('refuses to cache a set larger than the per-user cap', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    const huge = new Map<string, PermissionSpec>();
    for (let i = 0; i <= MAX_PERMISSIONS_PER_USER; i += 1) {
      huge.set(`r${i}.read`, {
        id: `p-${i}`,
        name: `r${i}.read`,
        resource: `r${i}`,
        action: 'read',
      });
    }
    await cache.set('u-fat', {
      userId: 'u-fat',
      permissions: huge,
      computedAt: asInstant('2026-05-10T00:00:00.000Z'),
    });

    // Nothing was written — the cap fires before the redis call.
    expect(redis.has('noip:cache:perm:u-fat')).toBe(false);
    expect(logger.events.some(e => e.level === 'error')).toBe(true);
  });
});
