// Wave-3 integration test: `RedisPermissionCache` against the Map-backed
// `FakeCacheRedis` stub.
//
// Wave 1 (`permission-cache.spec.ts`) already covers the unit-level
// behaviour — failure swallowing, oversized rejection, key prefix, etc.
// This file complements it by walking through the round-trip flows the
// composition root depends on once the resolver is wired against a real
// ioredis-shaped surface:
//
//   1. `set` then `get` returns the same set even after the cache TTL
//      has been touched (no truncation / no key collisions).
//   2. `set` honours the TTL passed via the constructor; an expired
//      entry is observed as a miss without an explicit invalidation.
//   3. `invalidate(userId)` only flushes the specified user; siblings
//      remain cached.
//   4. `invalidateAll()` clears every entry under the prefix even when
//      there are unrelated keys in the store.
//
// We deliberately avoid spinning a real Redis here — the production
// path is exercised by the docker-compose integration job. The point of
// this spec is to lock the cache contract at the seam where the
// composition root passes the shared client into `RedisPermissionCache`.

import {
  RedisPermissionCache,
  permissionCacheKey,
} from '../../../src/services/iam/permission-cache';
import type {
  EffectivePermissionSet,
  PermissionSpec,
} from '../../../src/services/iam/permission-resolver.service';
import { asInstant } from '../../../src/shared/kernel';
import { CapturingLogger, FakeCacheRedis } from './_iam-stubs';

function setOf(
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

const READ = (id: string, resource: string): PermissionSpec => ({
  id,
  name: `${resource}.read`,
  resource,
  action: 'read',
});

const ORIG_DATE_NOW = Date.now;

describe('RedisPermissionCache — integration against FakeCacheRedis', () => {
  afterEach(() => {
    Date.now = ORIG_DATE_NOW;
  });

  it('round-trips a populated permission set without loss', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    const original = setOf('user-42', [
      READ('p-1', 'cluster'),
      READ('p-2', 'dashboard'),
      READ('p-3', 'pipeline'),
    ]);

    await cache.set('user-42', original);
    const back = await cache.get('user-42');

    expect(back).not.toBeNull();
    expect(back!.userId).toBe('user-42');
    expect(back!.permissions.size).toBe(3);
    expect(back!.permissions.get('cluster.read')?.id).toBe('p-1');
    expect(back!.permissions.get('dashboard.read')?.id).toBe('p-2');
    expect(back!.permissions.get('pipeline.read')?.id).toBe('p-3');
    expect(back!.computedAt).toBe(original.computedAt);
    // No errors / warnings on the happy path.
    expect(
      logger.events.filter(e => e.level === 'warn' || e.level === 'error')
    ).toHaveLength(0);
  });

  it('honours the configured TTL — entries vanish after expiry', async () => {
    // Freeze "now" so the FakeCacheRedis purge() runs deterministically.
    let now = 1_700_000_000_000;
    Date.now = () => now;

    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({
      redis,
      logger,
      ttlSec: 30, // short window so we can advance past it
    });

    await cache.set('user-1', setOf('user-1', [READ('p-1', 'cluster')]));
    expect(await cache.get('user-1')).not.toBeNull();

    // Advance past the TTL window.
    now += 31_000;
    expect(await cache.get('user-1')).toBeNull();
  });

  it('invalidate(user) is surgical — siblings stay cached', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    await cache.set('user-1', setOf('user-1', [READ('p-1', 'cluster')]));
    await cache.set('user-2', setOf('user-2', [READ('p-2', 'cluster')]));

    await cache.invalidate('user-1');

    expect(await cache.get('user-1')).toBeNull();
    expect(await cache.get('user-2')).not.toBeNull();
    expect(redis.has(permissionCacheKey('user-2'))).toBe(true);
  });

  it('invalidateAll() drops every prefixed entry but leaves unrelated keys', async () => {
    const redis = new FakeCacheRedis();
    const logger = new CapturingLogger();
    const cache = new RedisPermissionCache({ redis, logger });

    // Plant two cache entries plus an unrelated key (e.g. a session) that
    // would coexist in the production keyspace under a different prefix.
    await cache.set('user-1', setOf('user-1', [READ('p-1', 'cluster')]));
    await cache.set('user-2', setOf('user-2', [READ('p-2', 'cluster')]));
    await redis.set('noip:sess:abc', 'session-payload');

    expect(redis.size()).toBe(3);

    await cache.invalidateAll();

    expect(redis.has(permissionCacheKey('user-1'))).toBe(false);
    expect(redis.has(permissionCacheKey('user-2'))).toBe(false);
    // The session key is untouched — `invalidateAll` only walks the
    // permission-cache namespace.
    expect(redis.has('noip:sess:abc')).toBe(true);
  });
});
