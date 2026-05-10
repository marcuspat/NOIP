// PermissionCache — Redis-backed cache for materialised permission sets.
//
// Per DDD-14 the TTL is 5 minutes. The key shape is
//
//   noip:cache:perm:<userId>
//
// We deliberately store the entire serialised set as a single string under
// a single key (`GET` / `SET`) rather than a hash-per-permission structure.
// At an expected p99 of ~60 permissions per user the JSON payload is well
// under 16 KiB, and a single `GET` lets us short-circuit the resolver hot
// path with a single round trip.
//
// Failure model: Redis is best-effort. A `get` failure returns `null` so
// the resolver computes live; a `set`/`invalidate` failure is logged and
// swallowed — the cached set will simply be stale at most until the TTL
// elapses or the next event-driven invalidation fires.

import {
  serialiseSet,
  deserialiseSet,
  type EffectivePermissionSet,
  type SerialisedEffectiveSet,
} from './permission-resolver.service';

/** Default TTL: 5 minutes per DDD-14 §"Caches and TTLs". */
export const DEFAULT_PERMISSION_CACHE_TTL_SEC = 300;

/** Sanity guard. Anything beyond this is almost certainly an error. */
export const MAX_PERMISSIONS_PER_USER = 10_000;

/** Key namespace. Centralised here so a typo can't drift the prefix. */
export const PERMISSION_CACHE_KEY_PREFIX = 'noip:cache:perm:';

export function permissionCacheKey(userId: string): string {
  return `${PERMISSION_CACHE_KEY_PREFIX}${userId}`;
}

/** Logger surface limited to what this cache uses. */
export interface PermissionCacheLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal Redis client surface — a strict subset of `ioredis`'s API. The
 * real ioredis client (`Redis | Cluster`) satisfies this; tests use a
 * Map-backed stub.
 */
export interface PermissionCacheRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSec: number, value: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  /**
   * Used by `invalidateAll`. We accept either a `scan`-style cursor API
   * or a simpler `keys(pattern)` fallback. Both are wrapped behind the
   * same call here.
   */
  scan(
    cursor: string,
    matchKeyword: 'MATCH',
    pattern: string,
    countKeyword: 'COUNT',
    count: number
  ): Promise<[cursor: string, keys: string[]]>;
}

export interface PermissionCache {
  get(userId: string): Promise<EffectivePermissionSet | null>;
  set(userId: string, set: EffectivePermissionSet): Promise<void>;
  invalidate(userId: string): Promise<void>;
  invalidateAll(): Promise<void>;
}

interface Deps {
  redis: PermissionCacheRedis;
  logger: PermissionCacheLogger;
  /** Override the default TTL. Useful in tests. */
  ttlSec?: number;
}

/**
 * Redis implementation. Every public method catches at the boundary so
 * this class is safe to call from request middleware without try/catch.
 */
export class RedisPermissionCache implements PermissionCache {
  private readonly redis: PermissionCacheRedis;
  private readonly logger: PermissionCacheLogger;
  private readonly ttlSec: number;

  constructor(deps: Deps) {
    this.redis = deps.redis;
    this.logger = deps.logger;
    this.ttlSec = deps.ttlSec ?? DEFAULT_PERMISSION_CACHE_TTL_SEC;
  }

  async get(userId: string): Promise<EffectivePermissionSet | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(permissionCacheKey(userId));
    } catch (err: unknown) {
      this.logger.warn('permission cache GET failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as SerialisedEffectiveSet;
      return deserialiseSet(parsed);
    } catch (err: unknown) {
      this.logger.warn('permission cache payload corrupt; treating as miss', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set(userId: string, set: EffectivePermissionSet): Promise<void> {
    if (set.permissions.size > MAX_PERMISSIONS_PER_USER) {
      this.logger.error('refusing to cache oversized permission set', {
        userId,
        size: set.permissions.size,
        cap: MAX_PERMISSIONS_PER_USER,
      });
      return;
    }
    let payload: string;
    try {
      payload = JSON.stringify(serialiseSet(set));
    } catch (err: unknown) {
      this.logger.error('failed to serialise permission set', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      await this.redis.setex(permissionCacheKey(userId), this.ttlSec, payload);
    } catch (err: unknown) {
      this.logger.warn('permission cache SET failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(permissionCacheKey(userId));
    } catch (err: unknown) {
      this.logger.warn('permission cache DEL failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Drop every cached entry. We `SCAN` because `KEYS` is O(N) and blocks
   * the Redis main thread on large datasets. Each cursor iteration deletes
   * a small batch then yields.
   */
  async invalidateAll(): Promise<void> {
    const pattern = `${PERMISSION_CACHE_KEY_PREFIX}*`;
    let cursor = '0';
    try {
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100
        );
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        cursor = next;
      } while (cursor !== '0');
    } catch (err: unknown) {
      this.logger.warn('permission cache invalidateAll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
