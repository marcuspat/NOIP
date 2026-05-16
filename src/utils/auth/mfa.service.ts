// MFAService — TOTP primary, Argon2id-hashed single-use backup codes,
// SMS / email challenges in Redis. See ADR-0009 (MFA strategy),
// ADR-0007 (Argon2id), ADR-0005 (Redis namespacing) and DDD-05 (IAM
// invariants).
//
// Constructor takes an injection envelope so tests can stub Redis, the
// clock, the password hasher, the logger, the EventBus, and config. The
// service is intentionally framework-free: it raises typed domain errors
// from `src/shared/errors` and the HTTP edge maps them.
//
// Constraints honoured:
//   * Backup codes are returned in plaintext only at issuance. Persisted
//     storage is Argon2id with a SHA-256 fingerprint fast-path so the
//     verifier does at most one Argon2 verification per attempt.
//   * Pending SMS / email challenges live under
//     `noip:mfa:<userId>:<method>` with a 5-minute TTL.
//   * The MFA verify endpoint guards itself with an internal Redis
//     counter (`noip:rl:mfa-verify:<userId>`). The dedicated rate-limit
//     middleware is owned by the sibling Redis-foundation agent.
//   * The TOTP secret is never returned outside of enrolment.

import crypto from 'crypto';
import speakeasy from 'speakeasy';
// `qrcode` ships no `.d.ts`; the project does not depend on its richer
// API surface so a narrow runtime require keeps strict mode happy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode') as {
  toDataURL(text: string): Promise<string>;
};
import { RateLimitError, ValidationError } from '../../shared/errors';
import { mfaVerificationAttemptsTotal } from '../../observability/metrics';
import {
  MFAMethod,
  MFASetupResponse,
  MFAVerificationRequest,
} from '../../types/auth.types';

// ---------------------------------------------------------------------------
// Injection contracts
// ---------------------------------------------------------------------------

/**
 * Minimal Redis surface used by the MFA service. We intentionally accept
 * a subset of the ioredis API so tests can pass a stub without pulling
 * the full client in.
 */
export interface MFARedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: 'EX',
    seconds?: number
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export interface MFAClock {
  now(): Date;
}

/**
 * Hasher contract — we only need hash + verify. The PasswordService in
 * `src/utils/auth/password.service.ts` is the production binding (it
 * uses Argon2id per ADR-0007).
 */
export interface MFABackupHasher {
  hashPassword(plain: string): Promise<string>;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
}

export interface MFALogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface MFAEventBus {
  publish(type: string, payload: Record<string, unknown>): Promise<void> | void;
}

export interface MFAConfig {
  issuer: string;
  /** TOTP window in steps; ADR-0009 default is ±2. */
  totpWindow: number;
  /** TTL for SMS / email challenges, in seconds. ADR-0009: 5 min. */
  challengeTtlSec: number;
  /** Number of backup codes to issue. ADR-0009: 10. */
  backupCodeCount: number;
  /** Length of each backup code, in plaintext characters (base32). */
  backupCodeLength: number;
  /** Verify-attempt budget per window, ADR-0009: 10 / 5 min. */
  rateLimitMax: number;
  rateLimitWindowSec: number;
  /** Redis key namespace root. */
  keyNamespace: string;
  /** ADR-0009: 7 days default grace window after MFA enable. */
  gracePeriodMs: number;
}

export interface MFAServiceDeps {
  redis?: MFARedisClient;
  clock?: MFAClock;
  hasher?: MFABackupHasher;
  logger?: MFALogger;
  eventBus?: MFAEventBus;
  config?: Partial<MFAConfig>;
}

/**
 * In-memory `MFARedisClient` fallback used when no Redis client is
 * supplied. Production wiring at the composition root (`src/app.ts`)
 * passes the shared ioredis client; this fallback exists so legacy
 * `new MFAService()` callsites that haven't been threaded through the
 * composition root yet still construct without throwing — they simply
 * cannot share challenge state across pods, which is logged loudly on
 * first use.
 */
class InMemoryMFARedisClient implements MFARedisClient {
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  private warnedOnce = false;
  constructor(private readonly logger?: MFALogger) {}
  private warn(): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    this.logger?.warn(
      'MFAService is using an in-memory Redis fallback. Wire the shared client at the composition root for production.'
    );
  }
  private isExpired(entry: { expiresAt: number | null }): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }
  async get(key: string): Promise<string | null> {
    this.warn();
    const e = this.store.get(key);
    if (!e || this.isExpired(e)) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(
    key: string,
    value: string,
    mode?: 'EX',
    seconds?: number
  ): Promise<unknown> {
    this.warn();
    const expiresAt =
      mode === 'EX' && typeof seconds === 'number'
        ? Date.now() + seconds * 1000
        : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    this.warn();
    return this.store.delete(key) ? 1 : 0;
  }
  async incr(key: string): Promise<number> {
    this.warn();
    const e = this.store.get(key);
    const n = (e && !this.isExpired(e) ? Number(e.value) || 0 : 0) + 1;
    this.store.set(key, {
      value: String(n),
      expiresAt: e?.expiresAt ?? null,
    });
    return n;
  }
  async expire(key: string, seconds: number): Promise<unknown> {
    this.warn();
    const e = this.store.get(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }
  async ttl(key: string): Promise<number> {
    this.warn();
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }
}

class ConsoleMFALogger implements MFALogger {
  debug(): void {}
  info(message: string): void {
    // eslint-disable-next-line no-console
    console.info(`[MFA] ${message}`);
  }
  warn(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[MFA] ${message}`);
  }
  error(message: string): void {
    // eslint-disable-next-line no-console
    console.error(`[MFA] ${message}`);
  }
}

class SystemMFAClock implements MFAClock {
  now(): Date {
    return new Date();
  }
}

class StubMFAHasher implements MFABackupHasher {
  async hashPassword(plain: string): Promise<string> {
    // Insecure placeholder used only when no hasher is supplied. Routes
    // that actually invoke MFA in production must inject the real
    // PasswordService at the composition root.
    return `stub:${plain}`;
  }
  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return hash === `stub:${plain}`;
  }
}

// ---------------------------------------------------------------------------
// Persistence shapes
// ---------------------------------------------------------------------------

export interface BackupCodeRecord {
  /** First 8 hex chars of SHA-256(plaintext). Fast-path lookup. */
  fingerprint: string;
  /** Argon2id hash of plaintext. Authoritative. */
  hash: string;
}

export type MFAVerificationOutcome =
  | { ok: true; method: MFAMethod['type']; backupCodeRemaining?: number }
  | { ok: false; reason: string };

export interface EnrolmentSecret {
  /** Base32-encoded TOTP secret. Caller must persist under `mfaSecret`. */
  secret: string;
  /** Plain `otpauth://` URI used for QR rendering. */
  otpauthUrl: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MFAConfig = {
  issuer: 'NOIP',
  totpWindow: numFromEnv('MFA_TOTP_WINDOW', 2),
  challengeTtlSec: numFromEnv('MFA_CHALLENGE_TTL_SEC', 300),
  backupCodeCount: 10,
  backupCodeLength: 16,
  rateLimitMax: numFromEnv('RATE_LIMIT_MFA_MAX', 10),
  rateLimitWindowSec: numFromEnv('RATE_LIMIT_MFA_WINDOW', 300),
  keyNamespace: 'noip:mfa',
  gracePeriodMs: numFromEnv('MFA_GRACE_PERIOD', 7 * 24 * 60 * 60 * 1000),
};

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Base32 alphabet per RFC 4648 — used for backup-code generation. We
// avoid 0/O/1/I and 8/B-style ambiguity by using the standard alphabet
// only (A-Z, 2-7) which already excludes 0, 1, 8, 9.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------------------------------------------------------------------------
// MFAService
// ---------------------------------------------------------------------------

export class MFAService {
  private readonly redis: MFARedisClient;
  private readonly clock: MFAClock;
  private readonly hasher: MFABackupHasher;
  private readonly logger: MFALogger;
  private readonly eventBus?: MFAEventBus;
  private readonly config: MFAConfig;

  constructor(deps: MFAServiceDeps = {}) {
    const fallbackLogger = deps.logger ?? new ConsoleMFALogger();
    this.redis = deps.redis ?? new InMemoryMFARedisClient(fallbackLogger);
    this.clock = deps.clock ?? new SystemMFAClock();
    this.hasher = deps.hasher ?? new StubMFAHasher();
    this.logger = fallbackLogger;
    if (deps.eventBus !== undefined) {
      this.eventBus = deps.eventBus;
    }
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
  }

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Generate a TOTP secret and its `otpauth://` URI plus a freshly
   * rendered QR data URL. **Does not persist** anything; the caller
   * (AuthService) is responsible for storing `secret` under
   * `mfaSecret` and for issuing backup codes once the user verifies a
   * first code.
   */
  async generateTOTPEnrolment(
    userId: string,
    label: string
  ): Promise<{ secret: EnrolmentSecret; qrCode: string }> {
    const generated = speakeasy.generateSecret({
      name: `${this.config.issuer} (${label})`,
      issuer: this.config.issuer,
      length: 32,
    });
    if (generated.base32 === undefined || generated.otpauth_url === undefined) {
      throw new Error('Failed to generate TOTP secret');
    }
    const qrCode = await QRCode.toDataURL(generated.otpauth_url);
    this.logger.info('mfa.enrolment.totp.generated', { userId });
    return {
      secret: {
        secret: generated.base32,
        otpauthUrl: generated.otpauth_url,
      },
      qrCode,
    };
  }

  /**
   * Back-compat wrapper for AuthService: returns the v1 setup response
   * shape (with `secret` and `qrCode`). The caller must NOT serialise
   * the returned `secret` to clients past the QR step.
   */
  async setupTOTP(userId: string): Promise<MFASetupResponse> {
    const enrolment = await this.generateTOTPEnrolment(userId, userId);
    return {
      secret: enrolment.secret.secret,
      qrCode: enrolment.qrCode,
      verificationRequired: true,
    };
  }

  /**
   * Begin SMS enrolment by issuing a short-lived challenge under
   * `noip:mfa:<userId>:sms`. The actual SMS delivery is the caller's
   * responsibility (the SMS provider adapter is a separate concern).
   * Compat shim for the legacy AuthService callsite.
   */
  async setupSMS(
    userId: string,
    _phoneNumber: string
  ): Promise<MFASetupResponse> {
    // Phone number lookup / delivery is the caller's responsibility — the
    // MFA service only stores challenge state. Caller persists
    // phoneNumber on the user document and pipes the challenge code
    // through its SMS adapter.
    await this.issueChallenge(userId, 'sms');
    return { verificationRequired: true };
  }

  /**
   * Begin email enrolment by issuing a short-lived challenge under
   * `noip:mfa:<userId>:email`. Email delivery is the caller's
   * responsibility. Compat shim for the legacy AuthService callsite.
   */
  async setupEmail(
    userId: string,
    _emailAddress: string
  ): Promise<MFASetupResponse> {
    await this.issueChallenge(userId, 'email');
    return { verificationRequired: true };
  }

  /**
   * Generate 10 high-entropy plaintext backup codes and the records
   * (fingerprint + Argon2id hash) the caller must persist under
   * `mfaBackupCodes`. The plaintext array is the only chance the user
   * has to record them.
   */
  async generateBackupCodes(): Promise<{
    plaintext: string[];
    records: BackupCodeRecord[];
  }> {
    const plaintext: string[] = [];
    const records: BackupCodeRecord[] = [];
    for (let i = 0; i < this.config.backupCodeCount; i += 1) {
      const code = this.randomBase32(this.config.backupCodeLength);
      plaintext.push(code);
      const record = await this.hashBackupCode(code);
      records.push(record);
    }
    return { plaintext, records };
  }

  /**
   * Replace a user's backup-code set. The caller is responsible for
   * gating this on a recent password / MFA proof — see ADR-0009. The
   * old codes are invalidated by overwriting `mfaBackupCodes` with the
   * returned `records`. The plaintext array is shown to the user
   * exactly once.
   */
  async regenerateBackupCodes(
    userId: string
  ): Promise<{ plaintext: string[]; records: BackupCodeRecord[] }> {
    const result = await this.generateBackupCodes();
    this.logger.info('mfa.backup_codes.regenerated', {
      userId,
      count: result.records.length,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Challenges (SMS / email)
  // -------------------------------------------------------------------------

  /**
   * Issue a 6-digit code for SMS / email and stash its hash in Redis
   * under `noip:mfa:<userId>:<method>` with the configured TTL. Returns
   * the plaintext so the caller can dispatch it; the service does not
   * own the SMS / email transport.
   */
  async issueChallenge(
    userId: string,
    method: 'sms' | 'email'
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = this.randomDigits(6);
    const key = this.challengeKey(userId, method);
    const fingerprint = this.fingerprint(code);
    await this.redis.set(key, fingerprint, 'EX', this.config.challengeTtlSec);
    const expiresAt = new Date(
      this.clock.now().getTime() + this.config.challengeTtlSec * 1000
    );
    this.logger.info('mfa.challenge.issued', { userId, method });
    return { code, expiresAt };
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * Verify a TOTP code against `secret` (base32). The caller looks up
   * `mfaSecret` with `+mfaSecret` first; we do not touch the database.
   */
  verifyTOTP(secret: string, code: string): boolean {
    if (typeof secret !== 'string' || secret === '') return false;
    if (typeof code !== 'string' || code === '') return false;
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: this.config.totpWindow,
      time: Math.floor(this.clock.now().getTime() / 1000),
    });
  }

  /**
   * Verify a backup code against the persisted set, returning the
   * record that was consumed (so the caller can splice it out of the
   * stored array). We hit the SHA fast-path first to avoid running
   * Argon2 ten times; only a fingerprint match triggers the Argon2
   * verify.
   */
  async verifyBackupCode(
    code: string,
    records: BackupCodeRecord[]
  ): Promise<{ ok: true; consumedIndex: number } | { ok: false }> {
    if (typeof code !== 'string' || code === '') return { ok: false };
    if (records.length === 0) return { ok: false };

    const fingerprint = this.fingerprint(code);
    const fpBuf = Buffer.from(fingerprint, 'utf8');
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (record === undefined) continue;
      const candidateBuf = Buffer.from(record.fingerprint, 'utf8');
      if (candidateBuf.length !== fpBuf.length) continue;
      if (!crypto.timingSafeEqual(candidateBuf, fpBuf)) continue;
      // Fingerprint matches — confirm with Argon2.
      const ok = await this.hasher.verifyPassword(code, record.hash);
      if (ok) return { ok: true, consumedIndex: i };
    }
    return { ok: false };
  }

  /**
   * Verify a code from a step-up challenge previously issued via
   * `issueChallenge`. Returns true on match and consumes the
   * challenge regardless of outcome (single-use semantics).
   */
  async verifyChallenge(
    userId: string,
    method: 'sms' | 'email',
    code: string
  ): Promise<boolean> {
    const key = this.challengeKey(userId, method);
    const stored = await this.redis.get(key);
    if (stored === null) return false;
    await this.redis.del(key);
    if (typeof code !== 'string' || code === '') return false;
    const candidate = this.fingerprint(code);
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * High-level verification entrypoint that bundles rate-limit
   * enforcement and event emission. The caller hands in everything
   * we need; we do not reach into the database.
   *
   * Emits `iam.mfa.verification_success` or `iam.mfa.verification_failed`
   * unless `emitEvent` is `false` (so AuthService can suppress the
   * publish on flows where it already emits the event itself).
   */
  async verify(args: {
    userId: string;
    request: MFAVerificationRequest;
    secret?: string | null;
    backupCodes?: BackupCodeRecord[];
    sessionId?: string;
    ipAddress?: string;
    emitEvent?: boolean;
  }): Promise<MFAVerificationOutcome> {
    await this.guardRateLimit(args.userId);

    const emit = args.emitEvent !== false;
    const wantsBackup =
      args.request.backupCode === true || args.request.method === 'backup';

    let outcome: MFAVerificationOutcome;
    if (wantsBackup) {
      outcome = await this.verifyAsBackup(
        args.request.code,
        args.backupCodes ?? []
      );
    } else if (args.request.method === 'totp') {
      outcome = this.verifyAsTOTP(args.request.code, args.secret);
    } else if (
      args.request.method === 'sms' ||
      args.request.method === 'email'
    ) {
      // Challenge already exchanged via verifyChallenge; we treat a
      // direct call here as a re-verification.
      const channel = args.request.method;
      const ok = await this.verifyChallenge(
        args.userId,
        channel,
        args.request.code
      );
      outcome = ok
        ? { ok: true, method: channel }
        : { ok: false, reason: 'invalid-challenge' };
    } else {
      outcome = { ok: false, reason: 'unsupported-method' };
    }

    // ADR-0023: record the verification outcome regardless of whether
    // the caller asked us to publish the event (AuthService suppresses
    // the publish when it emits its own event). Metric must always
    // mirror reality.
    mfaVerificationAttemptsTotal
      .labels({ result: outcome.ok ? 'success' : 'failure' })
      .inc();

    if (emit) {
      await this.emit(
        outcome.ok
          ? 'iam.mfa.verification_success'
          : 'iam.mfa.verification_failed',
        outcome.ok
          ? {
              userId: args.userId,
              method: outcome.method,
              ...(args.sessionId !== undefined
                ? { sessionId: args.sessionId }
                : {}),
            }
          : {
              userId: args.userId,
              method: args.request.method,
              ...(args.ipAddress !== undefined
                ? { ipAddress: args.ipAddress }
                : {}),
              reason: outcome.reason,
            }
      );
    }

    return outcome;
  }

  /**
   * Back-compat wrapper preserving the v1 boolean signature used by
   * AuthService today. The caller is expected to fetch `mfaSecret` and
   * `mfaBackupCodes` and pass them through; for now we accept the call
   * with neither, and return `false` so legacy code paths fail closed.
   *
   * Newer code should call `verify(...)` instead.
   */
  async verifyCode(
    userId: string,
    code: string,
    isBackupCode = false,
    args: {
      secret?: string | null;
      backupCodes?: BackupCodeRecord[];
      method?: MFAMethod['type'];
    } = {}
  ): Promise<boolean> {
    const method = args.method ?? (isBackupCode ? 'backup' : ('totp' as const));
    const outcome = await this.verify({
      userId,
      request: { code, method, backupCode: isBackupCode },
      ...(args.secret !== undefined ? { secret: args.secret } : {}),
      backupCodes: args.backupCodes ?? [],
      emitEvent: false,
    });
    return outcome.ok;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private verifyAsTOTP(
    code: string,
    secret: string | null | undefined
  ): MFAVerificationOutcome {
    if (secret === undefined || secret === null || secret === '') {
      return { ok: false, reason: 'no-totp-secret' };
    }
    return this.verifyTOTP(secret, code)
      ? { ok: true, method: 'totp' }
      : { ok: false, reason: 'invalid-totp' };
  }

  private async verifyAsBackup(
    code: string,
    records: BackupCodeRecord[]
  ): Promise<MFAVerificationOutcome> {
    const result = await this.verifyBackupCode(code, records);
    if (!result.ok) return { ok: false, reason: 'invalid-backup' };
    return {
      ok: true,
      method: 'backup',
      backupCodeRemaining: Math.max(records.length - 1, 0),
    };
  }

  private async guardRateLimit(userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId === '') {
      throw new ValidationError('userId is required');
    }
    const key = this.rateLimitKey(userId);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, this.config.rateLimitWindowSec);
    }
    if (count > this.config.rateLimitMax) {
      const ttl = await this.redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : this.config.rateLimitWindowSec;
      this.logger.warn('mfa.rate_limit.exceeded', {
        userId,
        count,
        retryAfter,
      });
      throw new RateLimitError(retryAfter, 'MFA verification rate limit', {
        scope: 'mfa-verify',
        userId,
      });
    }
  }

  private async emit(
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.eventBus === undefined) return;
    try {
      await this.eventBus.publish(type, payload);
    } catch (err) {
      this.logger.error('mfa.event.publish_failed', {
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async hashBackupCode(code: string): Promise<BackupCodeRecord> {
    const hash = await this.hasher.hashPassword(code);
    return { fingerprint: this.fingerprint(code), hash };
  }

  /**
   * 8 hex chars of SHA-256(plaintext) — short enough that 10 codes
   * collide with negligible probability and long enough to avoid
   * trivial brute force.
   */
  private fingerprint(plaintext: string): string {
    return crypto
      .createHash('sha256')
      .update(plaintext, 'utf8')
      .digest('hex')
      .slice(0, 8);
  }

  private randomBase32(length: number): string {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      const byte = bytes[i] ?? 0;
      out += BASE32_ALPHABET.charAt(byte % BASE32_ALPHABET.length);
    }
    return out;
  }

  private randomDigits(length: number): string {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      const byte = bytes[i] ?? 0;
      out += String(byte % 10);
    }
    return out;
  }

  private challengeKey(userId: string, method: 'sms' | 'email'): string {
    return `${this.config.keyNamespace}:${userId}:${method}`;
  }

  private rateLimitKey(userId: string): string {
    return `noip:rl:mfa-verify:${userId}`;
  }
}
