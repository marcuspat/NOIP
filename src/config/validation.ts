import type { config as Config } from './index';

/**
 * Result of validating the runtime configuration.
 *
 * See ADR-0019 (`docs/architecture/adr/0019-feature-flag-config-strategy.md`)
 * for the policy. Validation is intentionally synchronous and pure so that it
 * can be invoked at startup, in tests, or from a CLI without side effects.
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
  const jwtSecret = cfg.security.jwt.secret ?? '';
  if (isProd && jwtSecret === PLACEHOLDER_JWT_SECRET) {
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

  // --- MongoDB --------------------------------------------------------------
  const mongoUri = cfg.database.mongodb.uri ?? '';
  if (mongoUri.trim().length === 0) {
    errors.push('MONGODB_URI must be a non-empty connection string');
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

export default validateConfig;
