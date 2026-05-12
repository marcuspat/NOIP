import type { Redis } from 'ioredis';
import logger from '../utils/logger';

/**
 * Minimal session state replicated to Redis for the auth hot path.
 *
 * Per ADR-0005 + ADR-0006 the auth middleware must be able to determine
 * "is this session still valid?" without a Mongo round-trip on every
 * request. We replicate just the bits the middleware reads:
 *   - is the session revoked?
 *   - what is the current refresh-token jti? (for refresh-time checks)
 *   - when does it expire?
 *
 * Mongo remains the durable record. Redis is best-effort; if the cache
 * misses or the connection is down we fall back to Mongo via the
 * supplied `mongoFallback` function.
 */
export interface SessionState {
  sessionId: string;
  userId: string;
  active: boolean;
  refreshTokenJti?: string;
  /** Unix seconds. */
  expiresAt: number;
  revokedReason?: string;
}

export class SessionCache {
  private readonly redis: Redis | null;
  private readonly ttlSec: number;
  private readonly prefix: string;

  constructor(opts: { redis: Redis | null; ttlSec?: number; prefix?: string } = { redis: null }) {
    this.redis = opts.redis;
    this.ttlSec = opts.ttlSec ?? 7 * 24 * 60 * 60; // refresh-token lifetime
    this.prefix = opts.prefix ?? 'session:';
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  /**
   * Write or replace the cached state. Called on login, refresh and
   * revocation. Falls open on Redis failure (best-effort cache).
   */
  async set(state: SessionState): Promise<void> {
    if (!this.redis) return;
    try {
      const ttl = Math.max(1, state.expiresAt - Math.floor(Date.now() / 1000));
      await this.redis.set(
        this.key(state.sessionId),
        JSON.stringify(state),
        'EX',
        Math.min(ttl, this.ttlSec)
      );
    } catch (err) {
      logger.warn('SessionCache.set failed; continuing without cache', {
        sessionId: state.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Look up the cached state. On miss or Redis error, the caller is
   * expected to fall back to Mongo and call `set()` to repopulate.
   */
  async get(sessionId: string): Promise<SessionState | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(this.key(sessionId));
      if (!raw) return null;
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      logger.warn('SessionCache.get failed; degrading to Mongo lookup', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Mark a session revoked. Used by logout, refresh-replay defence and
   * admin revocation. The revoked entry is kept until natural expiry so
   * a replayed token presenting the same sessionId is still detected.
   */
  async revoke(sessionId: string, reason: string): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(this.key(sessionId));
      if (raw) {
        const state = JSON.parse(raw) as SessionState;
        state.active = false;
        state.revokedReason = reason;
        await this.set(state);
      }
    } catch (err) {
      logger.warn('SessionCache.revoke failed; Mongo remains authoritative', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.key(sessionId));
    } catch (err) {
      logger.warn('SessionCache.delete failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Process-wide singleton. Bound late (during bootstrap) via
 * `bindDefaultSessionCache`. Defaults to a null-Redis instance so
 * call sites that fire before bootstrap (or in tests) still work
 * by falling back to Mongo.
 */
let defaultCache: SessionCache = new SessionCache();

export function getDefaultSessionCache(): SessionCache {
  return defaultCache;
}

export function bindDefaultSessionCache(cache: SessionCache): void {
  defaultCache = cache;
}
