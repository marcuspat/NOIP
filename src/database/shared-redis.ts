// Shared ioredis client (Phase 1 / ADR-0005, ADR-0016, ADR-0020).
//
// One Redis client per pod, period. This module is the single place where
// `new Redis(...)` / `new Redis.Cluster(...)` is invoked at application
// boot; every Redis-touching subsystem (rate limiter, JWT denylist,
// permission cache, sessions, MFA challenges) consumes the client from
// here. Avoids duplicate connections, duplicate keyPrefixes, and the
// "which client should the health probe ping?" problem.
//
// Connection details come from `config.database.redis`:
//   - `lazyConnect: true` (config default) so module import never
//     dials the network; the bootstrap calls `connect()` at startup.
//   - `keyPrefix` (`noip:`) so callers write un-prefixed keys.
//   - `maxRetriesPerRequest: 3` to fail fast under outage rather than
//     queue forever.
//   - `enableReadyCheck: true` so commands queue until INFO succeeds.
//   - Cluster mode if `clusterEnabled` is set on the config.
//
// All wiring is done via constructor injection — the composition root
// constructs the client once and threads it into the rate-limit
// middleware, the JWT manager, the permission cache, etc.

import Redis, { type Cluster, type RedisOptions } from 'ioredis';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * Union surface that both `Redis` and `Cluster` satisfy. We deliberately
 * accept either at the boundary; downstream consumers only call methods
 * that exist on both (GET/SET/MGET/DEL/SETEX/PING/QUIT/PIPELINE/SCAN).
 */
export type SharedRedisClient = Redis | Cluster;

/** Subset of the config that this module reads. Centralised so tests can shim it. */
export interface SharedRedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  lazyConnect?: boolean;
  connectTimeout?: number;
  commandTimeout?: number;
  enableReadyCheck?: boolean;
  family?: 4 | 6;
  clusterEnabled?: boolean;
  clusterNodes?: ReadonlyArray<{ host: string; port: number }>;
}

/** Logger surface; matches `winston.Logger`. */
export interface RedisLifecycleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Construct (but do not necessarily connect) the shared client. With
 * `lazyConnect: true` the constructor is non-blocking; call `connect()`
 * (or `ping()`) at bootstrap to actually open the socket.
 */
export function createSharedRedisClient(
  cfg: SharedRedisConfig = config.database.redis as SharedRedisConfig,
  log: RedisLifecycleLogger = logger
): SharedRedisClient {
  const baseOptions: RedisOptions = {
    host: cfg.host,
    port: cfg.port,
    ...(cfg.password ? { password: cfg.password } : {}),
    ...(cfg.db !== undefined ? { db: cfg.db } : {}),
    ...(cfg.keyPrefix !== undefined ? { keyPrefix: cfg.keyPrefix } : {}),
    maxRetriesPerRequest: cfg.maxRetriesPerRequest ?? 3,
    lazyConnect: cfg.lazyConnect ?? true,
    enableReadyCheck: cfg.enableReadyCheck ?? true,
    ...(cfg.connectTimeout !== undefined
      ? { connectTimeout: cfg.connectTimeout }
      : {}),
    ...(cfg.commandTimeout !== undefined
      ? { commandTimeout: cfg.commandTimeout }
      : {}),
    ...(cfg.family !== undefined ? { family: cfg.family } : {}),
  };

  let client: SharedRedisClient;

  if (
    cfg.clusterEnabled === true &&
    cfg.clusterNodes &&
    cfg.clusterNodes.length > 0
  ) {
    client = new Redis.Cluster(
      cfg.clusterNodes.map(n => ({ host: n.host, port: n.port })),
      {
        redisOptions: baseOptions,
        // `lazyConnect` lives at the cluster level too; ioredis copies it
        // into each node connection.
        lazyConnect: cfg.lazyConnect ?? true,
      }
    );
    log.info('shared redis client created (cluster mode)', {
      nodes: cfg.clusterNodes.length,
      keyPrefix: cfg.keyPrefix,
    });
  } else {
    client = new Redis(baseOptions);
    log.info('shared redis client created (single-node)', {
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
      keyPrefix: cfg.keyPrefix,
    });
  }

  // Lifecycle wiring. Wins/losses go to the logger so the readiness probe
  // and incident response tooling see consistent state. No reconnection
  // logic is added here on purpose — ioredis's built-in retry budget
  // (maxRetriesPerRequest + retryStrategy) is sufficient and adding a
  // second loop on top hides bugs.
  client.on('connect', () => {
    log.info('shared redis: connect');
  });
  client.on('ready', () => {
    log.info('shared redis: ready');
  });
  client.on('reconnecting', (delay: number) => {
    log.warn('shared redis: reconnecting', { delayMs: delay });
  });
  client.on('error', (err: Error) => {
    // Don't downgrade to warn — auth flows fail-closed on Redis outage.
    log.error('shared redis: error', { error: err.message });
  });
  client.on('end', () => {
    log.info('shared redis: end');
  });

  return client;
}

/**
 * Open the underlying socket if `lazyConnect` deferred it. Safe to call
 * multiple times: ioredis no-ops once the connection is `ready`. The
 * `ping` round-trip after `connect` proves the server is actually
 * responsive (vs. the socket merely being open).
 */
export async function connectAndPing(
  client: SharedRedisClient,
  log: RedisLifecycleLogger = logger
): Promise<void> {
  // `connect()` rejects if already connecting/ready in some ioredis
  // versions; tolerate that case rather than letting it crash bootstrap.
  try {
    await client.connect();
  } catch (err) {
    const status = (client as { status?: string }).status;
    if (status !== 'ready' && status !== 'connecting') {
      throw err;
    }
  }
  const reply = await client.ping();
  if (reply !== 'PONG') {
    throw new Error(`shared redis: unexpected PING reply: ${String(reply)}`);
  }
  log.info('shared redis: PING OK');
}

/**
 * Best-effort `ping` with a hard timeout. Used by the readiness probe;
 * we never want a slow Redis to block `/health/ready` past Kubernetes's
 * own probe timeout, and the load balancer would rather drain us than
 * wait. Returns `true` only on a successful PONG within `timeoutMs`.
 */
export async function pingWithTimeout(
  client: SharedRedisClient,
  timeoutMs = 200
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race<unknown>([
      client.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
      }),
    ]);
    return reply === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
