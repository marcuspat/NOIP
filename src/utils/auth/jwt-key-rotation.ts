// JWT key-rotation helpers (ADR-0025).
//
// The signing-window outage problem is the core reason this helper exists:
// when an operator rotates `JWT_SECRET` in production, any in-flight token
// signed with the previous secret must keep verifying until it ages out
// (15 minutes for access, 7 days for refresh by default). The verifier-side
// support is implemented in `JWTManager` via a `kid`-keyed key set; this
// module is the env-loading + minting front door that hands the manager
// a fully-formed `JwtKeySet`.
//
// Centralising the parsing here means the rules ("which env var", "what
// shape", "what minimum length", "how do new kids look") live in one
// place and can be unit-tested without spinning up the manager.

import { randomBytes } from 'crypto';

/** Minimum acceptable JWT secret length. Matches `validation.ts`. */
const MIN_JWT_SECRET_LENGTH = 32;

/** Default kid used when `JWT_ACTIVE_KID` is not set. */
const DEFAULT_ACTIVE_KID = 'kid-0';

/** Default placeholder shipped in the repo. Production must override it. */
const PLACEHOLDER_JWT_SECRET = 'your-secret-key-change-in-production';

/**
 * One entry in the rotation key set: an opaque `kid` plus the symmetric
 * secret used to sign / verify with that kid.
 */
export interface JwtKey {
  kid: string;
  secret: string;
}

/**
 * The resolved key set for the running process.
 *
 * - `active` is used to sign newly-minted tokens.
 * - `prior` is the set of older kids that must still verify tokens issued
 *   before the most recent rotation. The list is ordered newest-first so
 *   the verifier hits the most likely candidate first.
 */
export interface JwtKeySet {
  active: JwtKey;
  prior: JwtKey[];
}

/**
 * Parse the `JWT_PRIOR_KIDS` env var shape: `kid1:secret1,kid2:secret2`.
 *
 * Behaviour:
 * - Empty / missing input returns `[]`.
 * - Entries with no `:` separator, an empty kid, or an empty secret are
 *   rejected with a thrown `Error`. We *do not* silently drop them because
 *   a malformed entry in prod almost certainly means an operator typo in
 *   a Vault payload, and silently dropping it would leak a signing-window
 *   outage. Tests exercise both the happy and the malformed paths.
 * - Whitespace around tokens and the `:` is tolerated.
 *
 * Exported for direct unit testing — callers normally go through
 * {@link loadJwtKeySet}.
 */
export function parseJwtPriorKids(raw: string | undefined): JwtKey[] {
  if (!raw || raw.trim().length === 0) return [];
  const out: JwtKey[] = [];
  const seen = new Set<string>();
  for (const chunk of raw.split(',')) {
    const piece = chunk.trim();
    if (piece.length === 0) continue;
    const idx = piece.indexOf(':');
    if (idx <= 0 || idx === piece.length - 1) {
      throw new Error(
        `Malformed JWT_PRIOR_KIDS entry: ${JSON.stringify(piece)} (expected "kid:secret")`
      );
    }
    const kid = piece.slice(0, idx).trim();
    const secret = piece.slice(idx + 1).trim();
    if (kid.length === 0 || secret.length === 0) {
      throw new Error(
        `Malformed JWT_PRIOR_KIDS entry: ${JSON.stringify(piece)} (kid or secret empty)`
      );
    }
    if (seen.has(kid)) {
      throw new Error(
        `Duplicate kid in JWT_PRIOR_KIDS: ${JSON.stringify(kid)}`
      );
    }
    seen.add(kid);
    out.push({ kid, secret });
  }
  return out;
}

/**
 * Parse `JWT_PRIOR_KIDS` env (`kid:secret,kid:secret`) into a key
 * set. Used during rotation: the new secret signs, the old one
 * still verifies until tokens age out (15 min for access, 7d for
 * refresh by default).
 *
 * The active key is sourced from `JWT_SECRET` (required when this
 * function is invoked) and tagged with `JWT_ACTIVE_KID` (or `kid-0`
 * when unset). Prior kids must not collide with the active kid —
 * a collision is a configuration error and throws.
 */
export function loadJwtKeySet(env: NodeJS.ProcessEnv): JwtKeySet {
  const activeSecret = env['JWT_SECRET'];
  if (typeof activeSecret !== 'string' || activeSecret.length === 0) {
    throw new Error('JWT_SECRET must be set to load the JWT key set');
  }
  const activeKid = (env['JWT_ACTIVE_KID'] ?? DEFAULT_ACTIVE_KID).trim();
  if (activeKid.length === 0) {
    throw new Error('JWT_ACTIVE_KID must be non-empty when set');
  }
  const active: JwtKey = { kid: activeKid, secret: activeSecret };
  const prior = parseJwtPriorKids(env['JWT_PRIOR_KIDS']);
  for (const k of prior) {
    if (k.kid === active.kid) {
      throw new Error(
        `JWT_PRIOR_KIDS contains the active kid ${JSON.stringify(active.kid)}; ` +
          'remove it from the prior list before re-promoting'
      );
    }
  }
  return { active, prior };
}

/**
 * Generate a 256-bit secret + new kid (`kid-<unix-seconds>`).
 * Used by ops tooling to mint the next rotation candidate.
 *
 * The kid embeds the unix-seconds timestamp so successive rotations
 * sort lexicographically (`kid-1700000000` < `kid-1700000001`); ops
 * scripts that need to fold prior kids into `JWT_PRIOR_KIDS` can
 * sort and trim by kid age. The secret is 32 random bytes encoded
 * as URL-safe base64 with padding stripped, which is just over 42
 * characters of entropy-dense ASCII — comfortably above the 32-char
 * minimum enforced by validation.
 */
export function mintJwtKey(now: Date): { kid: string; secret: string } {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('mintJwtKey requires a valid Date');
  }
  const unixSeconds = Math.floor(now.getTime() / 1000);
  const kid = `kid-${unixSeconds}`;
  // 32 random bytes → 256 bits of entropy.
  const secret = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { kid, secret };
}

/**
 * Reject obviously-broken JWT secrets early. Used as a guard from
 * the manager's constructor so a misconfigured pod fails to boot
 * loudly rather than serving tokens with a placeholder secret.
 *
 * Returns the secret unchanged on success.
 */
export function assertProductionJwtSecret(
  secret: string,
  isProduction: boolean
): string {
  if (!isProduction) return secret;
  if (secret === PLACEHOLDER_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET must not be the default placeholder value in production'
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production (got ${secret.length})`
    );
  }
  return secret;
}
