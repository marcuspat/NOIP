import type { config as Config } from './index';
import { parseJwtPriorKids } from '../utils/auth/jwt-key-rotation';

/**
 * Result of validating the runtime configuration.
 *
 * See ADR-0019 (`docs/architecture/adr/0019-feature-flag-config-strategy.md`)
 * for the policy. Validation is intentionally synchronous and pure so that it
 * can be invoked at startup, in tests, or from a CLI without side effects.
 *
 * ADR-0025 strengthens the production-only rules: placeholder JWT secrets,
 * localhost MongoDB URIs, and malformed `JWT_PRIOR_KIDS` env values all
 * fail boot in production instead of being silently accepted.
 */
export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Default placeholder shipped in the repo. Production must override it. */
const PLACEHOLDER_JWT_SECRET = 'your-secret-key-change-in-production';

/** Minimum acceptable JWT secret length (errors below, warnings if non-prod). */
const MIN_JWT_SECRET_LENGTH = 32;

/** Pattern accepted by `jsonwebtoken` for `expiresIn` (e.g. "15m", "7d", "3600"). */
const TIME_STRING = /^\d+(?:\s*(?:ms|s|m|h|d|w|y))?$/i;

/**
 * Hosts that indicate a developer-only MongoDB target. Any of these
 * appearing in `MONGODB_URI` while `NODE_ENV=production` is treated as
 * a misconfiguration — the most common operator mistake is forgetting
 * to swap the connection string when promoting a config.
 */
const LOCAL_MONGO_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/**
 * Validate a fully built {@link Config} object against the runtime environment.
 *
 * Pure: does not mutate the inputs and does not throw. Callers decide how to
 * react to the report (`throw`, `console.warn`, structured logger, etc.).
 */
export function validateConfig(
  cfg: typeof Config,
  env: NodeJS.ProcessEnv
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = (env['NODE_ENV'] || cfg.app.environment) === 'production';

  // --- JWT secret -----------------------------------------------------------
  // ADR-0025: production refuses placeholder + sub-32-char secrets. The
  // placeholder check also runs against case-insensitive equality so that
  // a stray uppercase tweak by an operator doesn't sneak past.
  const jwtSecret = cfg.security.jwt.secret ?? '';
  if (
    isProd &&
    jwtSecret.toLowerCase() === PLACEHOLDER_JWT_SECRET.toLowerCase()
  ) {
    errors.push(
      'JWT_SECRET must not be the default placeholder value in production'
    );
  }
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    const msg = `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length})`;
    if (isProd) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  // --- JWT prior-kid window (ADR-0025) -------------------------------------
  // `JWT_PRIOR_KIDS` lets a rotated-out secret continue to verify until
  // tokens age out (15m access / 7d refresh by default). Malformed input
  // would silently shrink the verification key set and trigger a
  // signing-window outage, so reject malformed values *loudly* at boot.
  const priorKidsRaw = env['JWT_PRIOR_KIDS'];
  if (typeof priorKidsRaw === 'string' && priorKidsRaw.trim().length > 0) {
    try {
      parseJwtPriorKids(priorKidsRaw);
    } catch (err) {
      const msg = `JWT_PRIOR_KIDS is malformed: ${err instanceof Error ? err.message : String(err)}`;
      if (isProd) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // --- MongoDB --------------------------------------------------------------
  const mongoUri = cfg.database.mongodb.uri ?? '';
  if (mongoUri.trim().length === 0) {
    errors.push('MONGODB_URI must be a non-empty connection string');
  } else if (isProd && containsLocalHost(mongoUri)) {
    errors.push(
      'MONGODB_URI must not point at localhost / loopback addresses in production'
    );
  }

  // --- Redis ----------------------------------------------------------------
  // We treat redis as enabled whenever auth or any service that depends on
  // session/cache state is enabled. The current config does not gate redis
  // explicitly, so use auth as a proxy: auth requires session storage.
  const redisRequired = cfg.services.auth.enabled;
  const redisHost = cfg.database.redis.host ?? '';
  if (redisRequired && redisHost.trim().length === 0) {
    errors.push(
      'REDIS_HOST must be set when redis-backed services are enabled'
    );
  }

  // --- Numeric bounds -------------------------------------------------------
  const numericChecks: Array<[string, number, number]> = [
    ['app.port', cfg.app.port, 1],
    ['security.rateLimit.max', cfg.security.rateLimit.max, 1],
    ['security.rateLimit.windowMs', cfg.security.rateLimit.windowMs, 1],
    ['security.rateLimit.authMax', cfg.security.rateLimit.authMax, 1],
    ['database.mongodb.maxPoolSize', cfg.database.mongodb.maxPoolSize, 1],
    ['database.redis.port', cfg.database.redis.port, 1],
  ];
  for (const [name, value, min] of numericChecks) {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      errors.push(`${name} must be a finite number (got ${String(value)})`);
    } else if (value < min) {
      errors.push(`${name} must be >= ${min} (got ${value})`);
    }
  }

  // --- Time-string fields ---------------------------------------------------
  const accessExpiry = cfg.security.jwt.accessTokenExpiry;
  if (typeof accessExpiry !== 'string' || !TIME_STRING.test(accessExpiry)) {
    errors.push(
      `JWT_ACCESS_EXPIRY must be a parseable time string (got ${String(accessExpiry)})`
    );
  }
  const refreshExpiry = cfg.security.jwt.refreshTokenExpiry;
  if (typeof refreshExpiry !== 'string' || !TIME_STRING.test(refreshExpiry)) {
    errors.push(
      `JWT_REFRESH_EXPIRY must be a parseable time string (got ${String(refreshExpiry)})`
    );
  }

  // --- CORS in production ---------------------------------------------------
  if (isProd && cfg.security.cors.enabled) {
    const origins = cfg.security.cors.origins ?? [];
    for (const origin of origins) {
      if (origin === '*') {
        warnings.push('CORS origin "*" is unsafe in production');
      } else if (origin.includes('localhost')) {
        warnings.push(
          `CORS origin "${origin}" looks like a development host in production`
        );
      }
    }
  }

  // --- AI service in production --------------------------------------------
  if (
    isProd &&
    cfg.services.ai.enabled &&
    (cfg.services.ai.apiKey ?? '').trim().length === 0
  ) {
    errors.push(
      'AI_API_KEY must be set in production when AI_SERVICE_ENABLED is not "false"'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Return `true` when the supplied MongoDB connection string targets a
 * loopback address. We parse only enough of the URI to find the
 * host portion — full `mongodb://` URI parsing is overkill and brittle
 * (the format permits replica-set tuples, query strings, encoded
 * credentials with `@`, etc.) so we use a lowercase substring match
 * against the known dev-host list.
 *
 * Exported only via `validateConfig` — kept module-private so callers
 * don't grow a parallel "is this a dev URI?" heuristic.
 */
function containsLocalHost(uri: string): boolean {
  const lowered = uri.toLowerCase();
  for (const host of LOCAL_MONGO_HOSTS) {
    // Boundary heuristic: a localhost match must be preceded by `@`,
    // `/`, `(`, or appear right after the scheme separator, and must
    // be followed by `:`, `/`, `,`, `)`, `?`, or end-of-string. This
    // prevents spurious matches against e.g. `mongodb://prod-localhost`.
    const pattern = new RegExp(
      `(?:^|[@/(,])${host.replace(/[.[\]]/g, '\\$&')}(?=$|[:/,)?])`,
      'i'
    );
    if (pattern.test(lowered)) return true;
  }
  return false;
}

export default validateConfig;
