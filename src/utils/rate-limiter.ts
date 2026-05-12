import rateLimit, { Options, RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Redis } from 'ioredis';
import { config } from '../config';
import logger from './logger';

/**
 * Build an express-rate-limit handler.
 *
 * Per ADR-0014 we use a Redis-backed store when a Redis client is supplied,
 * so the sliding window is coherent across replicas. When Redis is not
 * available the limiter falls back to the in-memory store and a warning
 * is logged: the gate is preserved per-replica until Redis is back, with
 * the trade-off (per-replica counters, possible 2x effective limit across
 * 2 replicas) explicitly documented in the ADR.
 */
export function buildRateLimiter(
  opts: Partial<Options> & {
    redis?: Redis | null;
    /**
     * Distinguishes one limiter's keys from another's in the shared Redis
     * namespace (e.g. "global", "auth", "password-reset", "mfa").
     */
    namespace: string;
    windowMs: number;
    max: number;
  }
): RateLimitRequestHandler {
  const { redis, namespace, windowMs, max, ...rest } = opts;

  let store: Options['store'] | undefined;
  if (redis) {
    store = new RedisStore({
      // ioredis call() takes (cmd, ...args); shape matches RedisStore's
      // sendCommand contract. Cast the variadic to satisfy the types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: ((...args: string[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (redis as any).call(...args)) as any,
      prefix: `${config.database.redis.keyPrefix}ratelimit:${namespace}:`,
    });
  } else {
    logger.warn(
      `Rate limiter "${namespace}" using in-memory store (Redis not provided). ` +
        'Per-replica counters; cross-replica limits not enforced.'
    );
  }

  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP' },
    ...rest,
    ...(store ? { store } : {}),
  });
}

/**
 * Convenience builders matching the ADR-0014 policy:
 *
 * - Global: 100 req / 15 min per IP.
 * - Auth (login/register/refresh/MFA/password-reset): 5 req / 15 min per IP.
 *
 * Both keyed off the remote IP by default.
 */
export function buildGlobalLimiter(redis: Redis | null): RateLimitRequestHandler {
  return buildRateLimiter({
    redis,
    namespace: 'global',
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.max,
  });
}

export function buildAuthLimiter(redis: Redis | null): RateLimitRequestHandler {
  return buildRateLimiter({
    redis,
    namespace: 'auth',
    windowMs: config.security.rateLimit.authWindowMs,
    max: config.security.rateLimit.authMax,
  });
}
