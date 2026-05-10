// Redis-backed rate limiter (Phase 1 / ADR-0016).
//
// Built on `express-rate-limit` v8 + `rate-limit-redis` v4 with the
// shared ioredis client from `src/database/shared-redis.ts`. The store
// counts attempts under `noip:rl:*` (the global `keyPrefix` of the
// shared client is `noip:`, and the rate-limit-redis prefix below is
// `rl:`, which composes to the spec). Carefully avoiding the
// double-prefix bug — see `prefix` note below.
//
// Bucket semantics (ADR-0016):
//
//   - "general" (global API): fail-OPEN on Redis outage. When the store
//     throws we let the request through, log a critical metric, and
//     trust upstream WAF / ingress limits.
//   - "auth" / "password-reset" / "MFA" / "AI-cost": fail-CLOSED on
//     Redis outage. We can't count → we can't trust → 503.
//
// We expose a small factory rather than a singleton so the composition
// root can mount one limiter per route group with explicit semantics
// per ADR-0016. The `wrapWithFailureMode` helper swallows the
// rate-limit-redis "Connection is closed" / "ECONNREFUSED" surface and
// applies the right response.

import type { RequestHandler, Request, Response, NextFunction } from 'express';
import rateLimit, { type Options, type Store } from 'express-rate-limit';
import RedisStore, { type SendCommandFn } from 'rate-limit-redis';
import type { SharedRedisClient } from '../database/shared-redis';
import logger from '../utils/logger';

/** ADR-0016 bucket taxonomy. Drives the failure-mode decision. */
export type RateLimitBucket =
  | 'general'
  | 'auth'
  | 'password-reset'
  | 'mfa'
  | 'ai';

/** Buckets that must fail-CLOSED on Redis outage. */
const FAIL_CLOSED_BUCKETS: ReadonlySet<RateLimitBucket> = new Set([
  'auth',
  'password-reset',
  'mfa',
]);

export interface BucketLimiterOptions {
  /** ADR-0016 bucket; selects fail-open vs fail-closed semantics. */
  bucket: RateLimitBucket;
  /** Window in ms. */
  windowMs: number;
  /** Max attempts per window. */
  max: number;
  /** Optional override for the key generator. */
  keyGenerator?: (req: Request) => string;
  /** Optional message for the 429 body. */
  message?: string;
  /** Optional skip predicate (e.g. for health probes). */
  skip?: (req: Request) => boolean;
}

interface FactoryDeps {
  redis: SharedRedisClient;
  /** Override the logger (useful in tests). */
  log?: typeof logger;
}

/**
 * Build the `RedisStore` once per limiter instance. We MUST NOT pass a
 * `prefix` that duplicates the client's `keyPrefix`. ioredis prepends
 * `keyPrefix` ("noip:") to every command transparently, so the store's
 * own `prefix` should be just `rl:` to land at `noip:rl:*`.
 */
function buildStore(redis: SharedRedisClient): Store {
  // `sendCommand` proxies into ioredis. Prefer `client.call` (universally
  // available); ioredis Cluster supports it identically. The
  // rate-limit-redis types want `Promise<RedisReply>` so we cast.
  const sendCommand: SendCommandFn = (...args: string[]) =>
    (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
      ...args
    ) as unknown as ReturnType<SendCommandFn>;

  return new RedisStore({
    sendCommand,
    // NOT 'noip:rl:'. The shared client already prepends 'noip:', and
    // rate-limit-redis writes via the client. Double-prefixing would
    // produce `noip:noip:rl:*` keys which (a) violate ADR-0005 and
    // (b) silently break any operator who runs `KEYS noip:rl:*`.
    prefix: 'rl:',
  });
}

/**
 * Construct an `express-rate-limit` middleware backed by the shared
 * Redis client, wrapped in a failure-mode handler appropriate to the
 * bucket. The wrapper catches store errors raised synchronously by
 * `express-rate-limit` (it surfaces them via `next(err)` when its
 * internal try/catch fails) and translates them per ADR-0016.
 */
export function createBucketLimiter(
  opts: BucketLimiterOptions,
  deps: FactoryDeps
): RequestHandler {
  const { bucket, windowMs, max } = opts;
  const log = deps.log ?? logger;

  // express-rate-limit v8 changed several option names. Use the
  // documented current shape and let TS validate via the imported
  // `Options` type.
  const limitOptions: Partial<Options> = {
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: buildStore(deps.redis),
    message: {
      error: 'RATE_LIMIT_EXCEEDED',
      bucket: `bucket.${bucket}`,
      message: opts.message ?? 'Too many requests',
    },
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
  };

  const limiter = rateLimit(limitOptions);
  return wrapWithFailureMode(limiter, bucket, log);
}

/**
 * Wrap a rate-limit middleware so a Redis outage during the limiter's
 * own store call is translated into the bucket-appropriate fallback.
 *
 * - `general` / `ai`: fail-OPEN. Log + call `next()` so the request
 *   proceeds. Upstream limits (ingress / WAF) cap blast radius.
 * - `auth` / `password-reset` / `mfa`: fail-CLOSED. Send `503` so we
 *   never let an attacker brute force during a Redis blip.
 */
export function wrapWithFailureMode(
  limiter: RequestHandler,
  bucket: RateLimitBucket,
  log: typeof logger = logger
): RequestHandler {
  const failClosed = FAIL_CLOSED_BUCKETS.has(bucket);

  return (req: Request, res: Response, next: NextFunction): void => {
    let nextCalled = false;
    const wrappedNext: NextFunction = err => {
      nextCalled = true;
      if (err) {
        // The `express-rate-limit` middleware surfaces store errors
        // through `next(err)` so the route's error handler can decide.
        // We override that here per ADR-0016.
        onStoreError(err, bucket, failClosed, res, next, log);
        return;
      }
      next();
    };

    let result: unknown;
    try {
      result = limiter(req, res, wrappedNext);
    } catch (err) {
      onStoreError(err, bucket, failClosed, res, next, log);
      return;
    }

    // The middleware may also reject via a returned promise (it does in
    // v8). Catch that case too.
    if (result && typeof (result as { catch?: unknown }).catch === 'function') {
      (result as Promise<unknown>).catch(err => {
        if (nextCalled) return; // already handled
        onStoreError(err, bucket, failClosed, res, next, log);
      });
    }
  };
}

function onStoreError(
  err: unknown,
  bucket: RateLimitBucket,
  failClosed: boolean,
  res: Response,
  next: NextFunction,
  log: typeof logger
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);

  // Always emit the metric counter ADR-0016 references.
  log.error('noip_rate_limit_redis_unavailable_total', {
    bucket,
    failClosed,
    error: errorMessage,
  });

  if (failClosed) {
    if (!res.headersSent) {
      res.status(503).json({
        error: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
        bucket: `bucket.${bucket}`,
        message: 'Authentication backend temporarily unavailable',
      });
    }
    return;
  }

  // Fail-open path: log and let the request through. Upstream limits
  // (WAF / ingress) cover the blast radius.
  next();
}
