// JWT manager (Phase 1 / ADR-0006).
//
// Migrated from `jsonwebtoken` to `jose` (^6.1) and extended with:
//   - kid-based key set (active + prior verifiers) for rotation windows.
//   - Redis-backed denylist (`noip:deny:<jti>`) under the namespace from
//     ADR-0005, with TTLs that match the token's residual lifetime so
//     Redis self-cleans.
//   - Refresh token theft detection via a `family` claim and a Redis
//     family-state record (`noip:fam:<family>`); presenting a denylisted
//     refresh marks the entire family compromised.
//   - Hot-path optimisations: SecretKey objects are imported once per kid
//     and cached, and verification consults Redis with a single MGET for
//     both the deny entry and the family-state entry.
//
// Failure modes:
//   - Cryptographic / kid / type / family / passwordChangedAt failures
//     surface as `UnauthorizedError`.
//   - Redis outages on the *write* path (revoke / family-mark) log a
//     critical metric and are swallowed so a logout returns cleanly; the
//     access token then naturally expires. Outages on the *read* path
//     fail-closed (ADR-0016): a Redis error during verify is treated as
//     denylisted and rejected.
//
// TODO (Phase 1 wave 3): publish `iam.token.revoked`, `iam.session.opened`,
// `iam.session.closed` via EventBus where the existing logger.info calls
// are emitted today.

import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';
import type { JWTPayload as JoseJWTPayload } from 'jose';
import { createSecretKey, type KeyObject, randomUUID } from 'crypto';

import { config } from '../../config';
import type { JWTPayload } from '../../types/auth.types';
import { UnauthorizedError } from '../../shared/errors';
import logger from '../logger';

/**
 * One entry in the active key set. The active key signs new tokens; any
 * key in the set may be used to verify a token whose header carries the
 * matching `kid`.
 */
export interface JWTKey {
  kid: string;
  secret: string;
}

/**
 * Minimal Redis surface required by the manager. The real implementation
 * is a thin adapter over `ioredis`; tests pass a Map-backed stub.
 *
 * - `setEx(key, ttlSec, value)`: SET with EX in seconds.
 * - `get(key)`: GET.
 * - `mget(keys)`: MGET. Returns null per missing key.
 * - `del(keys)`: DEL one or more keys (variadic).
 */
export interface RedisLike {
  setEx(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<Array<string | null>>;
  del(...keys: string[]): Promise<unknown>;
}

/** Marker stored under `noip:deny:<jti>`. */
interface DenylistEntry {
  reason: string;
  revokedAt: string;
}

/** Marker stored under `noip:fam:<family>`. */
export interface FamilyState {
  status: 'active' | 'revoked' | 'compromised';
  reason?: string;
  at: string;
}

/** Result of `refresh()` — a fresh access + refresh pair. */
export interface RotatedTokenPair {
  accessToken: string;
  refreshToken: string;
  family: string;
}

/** Parsed time-string ("15m", "7d", "3600", "30s") to seconds. */
export function parseExpiryToSeconds(value: string): number {
  const trimmed = value.trim();
  const m = /^(\d+)\s*(ms|s|m|h|d|w|y)?$/i.exec(trimmed);
  if (!m) {
    throw new Error(`Invalid expiry string: ${value}`);
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  switch (unit) {
    case 'ms':
      return Math.max(1, Math.floor(n / 1000));
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 'w':
      return n * 604800;
    case 'y':
      return n * 31_536_000;
    default:
      return n;
  }
}

/**
 * Parse `JWT_PRIOR_KIDS` env shape: `kid1:secret1,kid2:secret2`.
 * Whitespace around tokens and the `:` is tolerated. Empty input → `[]`.
 */
export function parsePriorKids(raw: string | undefined): JWTKey[] {
  if (!raw || raw.trim().length === 0) return [];
  const out: JWTKey[] = [];
  for (const chunk of raw.split(',')) {
    const piece = chunk.trim();
    if (piece.length === 0) continue;
    const idx = piece.indexOf(':');
    if (idx <= 0 || idx === piece.length - 1) {
      logger.warn('Ignoring malformed JWT_PRIOR_KIDS entry', { entry: piece });
      continue;
    }
    out.push({
      kid: piece.slice(0, idx).trim(),
      secret: piece.slice(idx + 1).trim(),
    });
  }
  return out;
}

/**
 * Loader for the user record we need during verification — only the
 * `passwordChangedAt` instant. The default loader returns `null` so that
 * unit tests and pure crypto paths do not require Mongo. The middleware
 * and AuthService inject a real loader.
 */
export type PasswordChangedAtLoader = (userId: string) => Promise<Date | null>;

const DEFAULT_PASSWORD_CHANGED_LOADER: PasswordChangedAtLoader = async () =>
  null;

/** Key prefixes from ADR-0005. */
const DENY_PREFIX = 'noip:deny:';
const FAMILY_PREFIX = 'noip:fam:';

/** Default rotation overlap (`PRIOR_KID_TTL_MS`) — 24h. */
const DEFAULT_PRIOR_TTL_MS = 24 * 60 * 60 * 1000;

interface RotationEntry {
  key: JWTKey;
  cachedSecret: KeyObject;
  /** Unix ms after which this prior key is dropped from verification. */
  expiresAt: number | null;
}

export interface JWTManagerOptions {
  /** Override the active key (default: from config + env). */
  activeKey?: JWTKey;
  /** Override prior keys (default: from `JWT_PRIOR_KIDS` env). */
  priorKeys?: JWTKey[];
  /** Override the issuer / audience (default: from config). */
  issuer?: string;
  audience?: string;
  /** Lifetime (seconds). */
  accessExpirySec?: number;
  refreshExpirySec?: number;
  /** Redis client used for denylist + family state. */
  redis?: RedisLike;
  /** Load `passwordChangedAt` for a user during verification. */
  passwordChangedAtLoader?: PasswordChangedAtLoader;
  /** How long a rotated-out kid stays valid for verification (ms). */
  priorKidTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * JWT manager with kid-based rotation, jose-backed signing/verification,
 * Redis denylist, and refresh family theft detection.
 *
 * ## Backwards compatibility
 *
 * The legacy public API (`signToken`, `verifyToken`, `decodeToken`,
 * `refreshToken`, `createTokenPair`, `getTokenRemainingTime`,
 * `isTokenExpired`, `revokeToken`, `isTokenRevoked`) is preserved so
 * existing callers (middleware, service, prior tests) keep working.
 * `verifyToken` still returns `null` on failure to match the existing
 * call sites; the middleware translates `null` to a 401 via
 * `UnauthorizedError`.
 */
export class JWTManager {
  /** Map from kid → cached SecretKey + JWTKey + optional expiry. */
  private readonly keys: Map<string, RotationEntry>;
  private activeKid: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessExpirySec: number;
  private readonly refreshExpirySec: number;
  private readonly priorKidTtlMs: number;
  private redis: RedisLike | undefined;
  private readonly loadPasswordChangedAt: PasswordChangedAtLoader;
  private readonly now: () => number;

  constructor(opts: JWTManagerOptions = {}) {
    const fromEnvActive: JWTKey = opts.activeKey ?? {
      kid: process.env['JWT_ACTIVE_KID'] ?? 'kid-0',
      secret: config.security.jwt.secret,
    };

    const fromEnvPrior: JWTKey[] =
      opts.priorKeys ?? parsePriorKids(process.env['JWT_PRIOR_KIDS']);

    if (
      config.app.environment === 'production' &&
      fromEnvActive.secret === 'your-secret-key-change-in-production'
    ) {
      throw new Error('JWT secret must be changed in production');
    }

    this.issuer = opts.issuer ?? config.security.jwt.issuer;
    this.audience = opts.audience ?? config.security.jwt.audience;
    this.accessExpirySec =
      opts.accessExpirySec ??
      parseExpiryToSeconds(config.security.jwt.accessTokenExpiry);
    this.refreshExpirySec =
      opts.refreshExpirySec ??
      parseExpiryToSeconds(config.security.jwt.refreshTokenExpiry);
    this.priorKidTtlMs = opts.priorKidTtlMs ?? DEFAULT_PRIOR_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.loadPasswordChangedAt =
      opts.passwordChangedAtLoader ?? DEFAULT_PASSWORD_CHANGED_LOADER;
    if (opts.redis !== undefined) {
      this.redis = opts.redis;
    }

    this.keys = new Map();
    this.activeKid = fromEnvActive.kid;
    this.installKey(fromEnvActive, null);
    for (const k of fromEnvPrior) {
      // Prior kids loaded from env do not carry an expiry — they are
      // assumed to be in the configured rotation window already.
      this.installKey(k, this.now() + this.priorKidTtlMs);
    }
  }

  /** Replace the configured Redis client at runtime. */
  setRedis(redis: RedisLike | undefined): void {
    this.redis = redis;
  }

  /** The currently active signing kid. */
  getActiveKid(): string {
    return this.activeKid;
  }

  /**
   * Add a new key as the active signer; the previously active key (and
   * any other prior keys) remain as verifiers for `priorKidTtlMs`.
   */
  rotateKey(newKey: JWTKey): void {
    if (this.keys.has(newKey.kid)) {
      // Re-promote an existing key. Drop its expiry so it stays active.
      const entry = this.keys.get(newKey.kid)!;
      entry.expiresAt = null;
    } else {
      this.installKey(newKey, null);
    }
    // Mark the previous active key as a verifier-only entry.
    const previousActive = this.activeKid;
    if (previousActive !== newKey.kid) {
      const prev = this.keys.get(previousActive);
      if (prev) {
        prev.expiresAt = this.now() + this.priorKidTtlMs;
      }
    }
    this.activeKid = newKey.kid;
  }

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  /**
   * Sign a token. Accepts the legacy callsite shape `(payload, tokenType)`
   * where `payload` is a `JWTPayload`-shaped object and `tokenType` selects
   * the lifetime; the active kid is always used for signing. A `jti` is
   * minted if none is present, and a `family` is minted for refresh tokens
   * that lack one.
   */
  async signToken(
    payload: Partial<JWTPayload> & Record<string, unknown>,
    tokenType: 'access' | 'refresh' = 'access'
  ): Promise<string> {
    try {
      const expirySec =
        tokenType === 'access' ? this.accessExpirySec : this.refreshExpirySec;
      const active = this.requireActiveEntry();
      const jti =
        typeof payload['jti'] === 'string' && payload['jti'].length > 0
          ? (payload['jti'] as string)
          : randomUUID();
      const family =
        typeof payload['family'] === 'string' &&
        (payload['family'] as string).length > 0
          ? (payload['family'] as string)
          : tokenType === 'refresh'
            ? randomUUID()
            : undefined;

      const claims: Record<string, unknown> = { ...payload, type: tokenType };
      delete claims['iat'];
      delete claims['exp'];
      delete claims['iss'];
      delete claims['aud'];
      claims['jti'] = jti;
      if (family !== undefined) {
        claims['family'] = family;
      }

      const builder = new SignJWT(claims as JoseJWTPayload)
        .setProtectedHeader({ alg: 'HS256', kid: active.key.kid, typ: 'JWT' })
        .setIssuedAt()
        .setIssuer(this.issuer)
        .setAudience(this.audience)
        .setJti(jti)
        .setExpirationTime(`${expirySec}s`);

      return await builder.sign(active.cachedSecret);
    } catch (error) {
      logger.error('Failed to sign JWT token', { error, tokenType });
      throw new Error('Token generation failed');
    }
  }

  /**
   * Mint an access + refresh pair for a freshly opened session. A fresh
   * `family` UUID is generated and bound to both tokens.
   */
  async createTokenPair(
    payload: Partial<JWTPayload> & Record<string, unknown>
  ): Promise<{ accessToken: string; refreshToken: string; family: string }> {
    try {
      const family = randomUUID();
      const accessToken = await this.signToken(
        { ...payload, family },
        'access'
      );
      const refreshToken = await this.signToken(
        { ...payload, family },
        'refresh'
      );
      // TODO: publish via EventBus — iam.session.opened
      logger.info('iam.session.opened', {
        userId: payload['sub'],
        sessionId: payload['sessionId'],
        family,
      });
      return { accessToken, refreshToken, family };
    } catch (error) {
      logger.error('Failed to create token pair', { error });
      throw new Error('Token pair creation failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  /**
   * Verify a token cryptographically and against the denylist + family state
   * + passwordChangedAt. Returns `null` on any failure so the middleware can
   * surface a single `UnauthorizedError`.
   */
  async verifyToken(
    token: string,
    tokenType: 'access' | 'refresh' = 'access'
  ): Promise<JWTPayload | null> {
    try {
      const verified = await this.verifyOrThrow(token, tokenType);
      return verified;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        logger.warn('Token verification rejected', {
          tokenType,
          reason: error.message,
        });
        return null;
      }
      logger.error('Failed to verify JWT token', { error, tokenType });
      return null;
    }
  }

  /**
   * Variant that throws `UnauthorizedError` instead of returning `null`.
   * Used by the refresh path to attribute the failure precisely.
   */
  async verifyOrThrow(
    token: string,
    tokenType: 'access' | 'refresh'
  ): Promise<JWTPayload> {
    let result: { payload: JoseJWTPayload };
    try {
      result = await jwtVerify(
        token,
        async header => {
          const kid = header.kid;
          if (typeof kid !== 'string' || kid.length === 0) {
            throw new UnauthorizedError('Missing kid');
          }
          const entry = this.keys.get(kid);
          if (!entry) {
            throw new UnauthorizedError('Unknown kid');
          }
          if (entry.expiresAt !== null && entry.expiresAt < this.now()) {
            // Lazy-evict expired prior keys.
            this.keys.delete(kid);
            throw new UnauthorizedError('Kid no longer trusted');
          }
          return entry.cachedSecret;
        },
        {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: ['HS256'],
        }
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        throw new UnauthorizedError('Token expired');
      }
      throw new UnauthorizedError('Invalid token');
    }

    const payload = result.payload as unknown as JWTPayload;
    if (payload.type !== tokenType) {
      throw new UnauthorizedError('Token type mismatch');
    }

    const jti = (result.payload as { jti?: string }).jti;
    const family = (result.payload as { family?: string }).family;
    if (!jti) {
      throw new UnauthorizedError('Missing jti');
    }

    // Single Redis round trip: fetch deny + family state together.
    if (this.redis) {
      const keys: string[] = [`${DENY_PREFIX}${jti}`];
      if (family) keys.push(`${FAMILY_PREFIX}${family}`);
      let values: Array<string | null>;
      try {
        values = await this.redis.mget(keys);
      } catch (err) {
        // Fail-closed per ADR-0016 for auth.
        logger.error('Redis MGET failed during verify; rejecting', { err });
        throw new UnauthorizedError('Auth backend unavailable');
      }
      const denyHit = values[0];
      const familyHit = family ? values[1] : null;
      if (denyHit) {
        throw new UnauthorizedError('Token revoked');
      }
      if (familyHit) {
        try {
          const fam = JSON.parse(familyHit) as FamilyState;
          if (fam.status === 'compromised' || fam.status === 'revoked') {
            throw new UnauthorizedError(
              fam.status === 'compromised'
                ? 'Token family compromised'
                : 'Token family revoked'
            );
          }
        } catch (err) {
          if (err instanceof UnauthorizedError) throw err;
          // Corrupt family record — fail-closed.
          logger.error('Corrupt family state record', { family, err });
          throw new UnauthorizedError('Token family state invalid');
        }
      }
    }

    // passwordChangedAt enforcement.
    const sub = payload.sub;
    if (typeof sub === 'string' && sub.length > 0) {
      const changedAt = await this.loadPasswordChangedAt(sub);
      if (changedAt) {
        const iat = (result.payload.iat ?? 0) * 1000;
        if (changedAt.getTime() > iat) {
          throw new UnauthorizedError('Token issued before password change');
        }
      }
    }

    return payload;
  }

  /** Decode without verifying. Returns null on parse failure. */
  async decodeToken(token: string): Promise<JWTPayload | null> {
    try {
      return decodeJwt(token) as unknown as JWTPayload;
    } catch (error) {
      logger.error('Failed to decode JWT token', { error });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh rotation + theft detection
  // ---------------------------------------------------------------------------

  /**
   * Rotate a refresh token. Verifies once (denylist + family + sig + pwdChange),
   * then issues a fresh access + refresh under the same family and denylists
   * the consumed refresh token's `jti`.
   *
   * Theft detection: if the supplied refresh token is *already* on the
   * denylist, the entire family is marked compromised so any other
   * outstanding token in that family is rejected on next verify.
   */
  async refreshToken(refreshToken: string): Promise<RotatedTokenPair | null> {
    try {
      // Look up jti + family up front so we can mark the family compromised
      // on a denylist hit even though `verifyOrThrow` would also detect it.
      const decoded = decodeJwt(refreshToken) as JoseJWTPayload & {
        jti?: string;
        family?: string;
        type?: 'access' | 'refresh';
      };
      const jti = decoded.jti;
      const family = decoded.family;

      // Pre-check denylist explicitly so we can attribute "replay" before
      // doing the (slightly heavier) verify path.
      if (this.redis && jti) {
        let prior: string | null = null;
        try {
          prior = await this.redis.get(`${DENY_PREFIX}${jti}`);
        } catch (err) {
          logger.error('Redis GET failed during refresh pre-check', { err });
          throw new UnauthorizedError('Auth backend unavailable');
        }
        if (prior && family) {
          await this.markFamilyCompromised(family, 'refresh-replay');
          throw new UnauthorizedError('Refresh token already used');
        }
      }

      // Single full verify (no double pass).
      const payload = await this.verifyOrThrow(refreshToken, 'refresh');

      const sub = payload.sub;
      const sessionId = payload.sessionId;
      const username = payload.username;
      const email = payload.email;
      const roles = payload.roles;
      const permissions = payload.permissions;
      const sameFamily =
        family ?? (payload as unknown as { family?: string }).family;

      if (!sameFamily) {
        throw new UnauthorizedError('Refresh token missing family');
      }

      const newAccess = await this.signToken(
        {
          sub,
          username,
          email,
          roles,
          permissions,
          sessionId,
          family: sameFamily,
        },
        'access'
      );
      const newRefresh = await this.signToken(
        {
          sub,
          username,
          email,
          roles,
          permissions,
          sessionId,
          family: sameFamily,
        },
        'refresh'
      );

      // Denylist the consumed refresh token's jti for the rest of its
      // lifetime so a replay is caught.
      if (jti) {
        const remainingMs = this.tokenRemainingMsFromPayload(
          (decoded.exp ?? 0) * 1000
        );
        await this.denylistJti(jti, remainingMs, 'refresh-rotated');
      }

      return {
        accessToken: newAccess,
        refreshToken: newRefresh,
        family: sameFamily,
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        logger.warn('Refresh rejected', { reason: error.message });
        return null;
      }
      logger.error('Failed to refresh token', { error });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Denylist (Redis-backed)
  // ---------------------------------------------------------------------------

  /**
   * Add a token to the denylist. Honours the token's residual lifetime as
   * the Redis TTL so the entry self-cleans after the token would have
   * expired anyway. Also marks the family as revoked when the token is
   * a refresh; access tokens don't carry session-wide authority.
   */
  async revokeToken(token: string, reason = 'manual'): Promise<void> {
    let jti: string | undefined;
    let exp: number | undefined;
    let family: string | undefined;
    let type: 'access' | 'refresh' | undefined;
    try {
      const decoded = decodeJwt(token) as {
        jti?: string;
        exp?: number;
        family?: string;
        type?: 'access' | 'refresh';
      };
      jti = decoded.jti;
      exp = decoded.exp;
      family = decoded.family;
      type = decoded.type;
    } catch (err) {
      logger.warn('revokeToken: undecodable token', { err });
      return;
    }

    if (!jti) {
      logger.warn('revokeToken: token has no jti');
      return;
    }

    const remainingMs = this.tokenRemainingMsFromPayload((exp ?? 0) * 1000);
    await this.denylistJti(jti, remainingMs, reason);

    if (type === 'refresh' && family) {
      // Revoking a refresh implicitly revokes the whole family so the
      // session can't be resurrected on another device with a stolen pair.
      await this.markFamilyRevoked(family, reason);
    }

    // TODO: publish via EventBus — iam.token.revoked
    logger.info('iam.token.revoked', { jti, reason, family, type });
  }

  /**
   * Test whether a token is denylisted. Returns `true` when the token is
   * known-revoked, `true` (fail-closed) when Redis is unreachable, and
   * `false` otherwise.
   */
  async isTokenRevoked(token: string): Promise<boolean> {
    if (!this.redis) return false;
    let jti: string | undefined;
    try {
      const decoded = decodeJwt(token) as { jti?: string };
      jti = decoded.jti;
    } catch {
      return true;
    }
    if (!jti) return true;
    try {
      const v = await this.redis.get(`${DENY_PREFIX}${jti}`);
      return v !== null;
    } catch (err) {
      logger.error('Redis GET failed in isTokenRevoked; failing closed', {
        err,
      });
      return true;
    }
  }

  /** Mark a refresh family as compromised — every token in it is rejected. */
  async markFamilyCompromised(family: string, reason: string): Promise<void> {
    await this.writeFamilyState(family, {
      status: 'compromised',
      reason,
      at: new Date().toISOString(),
    });
    // TODO: publish via EventBus — iam.session.suspicious + iam.token.revoked
    logger.warn('iam.session.suspicious', { family, reason });
  }

  /** Mark a refresh family as cleanly revoked (e.g. logout). */
  async markFamilyRevoked(family: string, reason: string): Promise<void> {
    await this.writeFamilyState(family, {
      status: 'revoked',
      reason,
      at: new Date().toISOString(),
    });
    // TODO: publish via EventBus — iam.session.closed
    logger.info('iam.session.closed', { family, reason });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  getTokenRemainingTime(token: string): number {
    try {
      const decoded = decodeJwt(token) as { exp?: number };
      if (!decoded.exp) return 0;
      return Math.max(0, decoded.exp * 1000 - this.now());
    } catch {
      return 0;
    }
  }

  isTokenExpired(token: string): boolean {
    return this.getTokenRemainingTime(token) === 0;
  }

  generateKeyId(): string {
    return `kid-${randomUUID()}`;
  }

  private installKey(key: JWTKey, expiresAt: number | null): void {
    const cachedSecret = createSecretKey(Buffer.from(key.secret, 'utf8'));
    this.keys.set(key.kid, { key, cachedSecret, expiresAt });
  }

  private requireActiveEntry(): RotationEntry {
    const e = this.keys.get(this.activeKid);
    if (!e) {
      throw new Error(`Active kid ${this.activeKid} is not in the key set`);
    }
    return e;
  }

  private tokenRemainingMsFromPayload(expMs: number): number {
    if (!expMs || expMs <= this.now()) return 0;
    return expMs - this.now();
  }

  private async denylistJti(
    jti: string,
    remainingMs: number,
    reason: string
  ): Promise<void> {
    if (!this.redis) {
      logger.error(
        'noip_denylist_unavailable_total: Redis missing; token cannot be revoked',
        { jti, reason }
      );
      return;
    }
    if (remainingMs <= 0) {
      // Already expired — nothing to denylist.
      return;
    }
    const ttlSec = Math.max(1, Math.ceil(remainingMs / 1000));
    const entry: DenylistEntry = {
      reason,
      revokedAt: new Date().toISOString(),
    };
    try {
      await this.redis.setEx(
        `${DENY_PREFIX}${jti}`,
        ttlSec,
        JSON.stringify(entry)
      );
    } catch (err) {
      logger.error(
        'noip_denylist_unavailable_total: Redis SETEX failed; token cannot be revoked',
        { err, jti, reason }
      );
    }
  }

  private async writeFamilyState(
    family: string,
    state: FamilyState
  ): Promise<void> {
    if (!this.redis) {
      logger.error(
        'noip_family_state_unavailable_total: Redis missing; family state cannot be written',
        { family, state }
      );
      return;
    }
    // Family state must outlive the longest token in the family.
    const ttlSec = this.refreshExpirySec;
    try {
      await this.redis.setEx(
        `${FAMILY_PREFIX}${family}`,
        ttlSec,
        JSON.stringify(state)
      );
    } catch (err) {
      logger.error('noip_family_state_unavailable_total: Redis SETEX failed', {
        err,
        family,
        state,
      });
    }
  }
}

/**
 * Thin adapter that exposes the `RedisLike` surface on top of the
 * platform's `RedisManager`. Kept here so callers don't need to know
 * about the underlying ioredis API.
 */
export function adaptRedisManager(client: {
  setex(k: string, t: number, v: string): Promise<unknown>;
  get(k: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  del(...keys: string[]): Promise<unknown>;
}): RedisLike {
  return {
    setEx: (key, ttl, value) => client.setex(key, ttl, value),
    get: key => client.get(key),
    mget: keys => client.mget(...keys),
    del: (...keys) => client.del(...keys),
  };
}
