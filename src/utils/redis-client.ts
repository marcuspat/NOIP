import { Redis, RedisOptions } from 'ioredis';
import logger from './logger';

/**
 * Build an ioredis client that does NOT open a socket at construction time
 * and never crashes the process with an unhandled `error` event.
 *
 * Rationale: several modules (auth controller, rate-limit middleware) need a
 * Redis handle at import time, but importing a module must not require a live
 * Redis. With `lazyConnect` the first command triggers the connection; with a
 * bounded retry budget and offline queue disabled, commands fail fast when
 * Redis is down. Callers that wrap Redis calls in try/catch then fail open.
 */
export function createLazyRedis(connection?: RedisOptions | string): Redis {
  const safeOpts: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null, // do not endlessly reconnect
  };

  const client =
    typeof connection === 'string'
      ? new Redis(connection, safeOpts)
      : new Redis({ ...safeOpts, ...connection });

  client.on('error', (err: Error) => {
    logger.warn('Redis client error (continuing without cache)', {
      error: err.message,
    });
  });

  return client;
}
