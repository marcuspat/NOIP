// Unit tests for MFAService (ADR-0009 / wave 3).
//
// We exercise the service against a memory-backed Redis stub and a
// stubbed Argon2id-style hasher so the suite is fast (no real Argon2
// rounds) while still exercising the fingerprint fast-path semantics.

import speakeasy from 'speakeasy';
import {
  MFARedisClient,
  MFAService,
  BackupCodeRecord,
  MFAEventBus,
} from '../../../src/utils/auth/mfa.service';
import { RateLimitError } from '../../../src/shared/errors';

class MemoryRedis implements MFARedisClient {
  store = new Map<string, { value: string; expiresAt?: number }>();
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(
    key: string,
    value: string,
    mode?: 'EX',
    seconds?: number
  ): Promise<unknown> {
    const entry: { value: string; expiresAt?: number } = { value };
    if (mode === 'EX' && seconds !== undefined) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
    this.store.set(key, entry);
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const current = entry === undefined ? 0 : Number(entry.value);
    const next = current + 1;
    if (entry === undefined) {
      this.store.set(key, { value: String(next) });
    } else {
      entry.value = String(next);
    }
    return next;
  }
  async expire(key: string, seconds: number): Promise<unknown> {
    const entry = this.store.get(key);
    if (entry === undefined) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }
  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (entry === undefined) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.max(
      Math.ceil((entry.expiresAt - Date.now()) / 1000),
      0
    );
  }
}

/**
 * Test hasher: prefixes the hash to make the encoding visible and skips
 * the Argon2 cost (this is a pure unit test; correctness, not speed,
 * matters here).
 */
class FakeHasher {
  async hashPassword(plain: string): Promise<string> {
    return `argon2id$${Buffer.from(plain).toString('base64')}`;
  }
  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return hash === `argon2id$${Buffer.from(plain).toString('base64')}`;
  }
}

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeService(
  overrides: {
    redis?: MFARedisClient;
    eventBus?: MFAEventBus;
    rateLimitMax?: number;
  } = {}
): {
  service: MFAService;
  redis: MFARedisClient;
  bus: MFAEventBus;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const redis = overrides.redis ?? new MemoryRedis();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus: MFAEventBus =
    overrides.eventBus ?? {
      publish: (type, payload) => {
        events.push({ type, payload });
      },
    };
  const service = new MFAService({
    redis,
    clock: { now: () => new Date() },
    hasher: new FakeHasher(),
    logger: silentLogger,
    eventBus: bus,
    config: {
      issuer: 'NOIP-test',
      rateLimitMax: overrides.rateLimitMax ?? 100,
      rateLimitWindowSec: 60,
    },
  });
  return { service, redis, bus, events };
}

describe('MFAService — enrolment', () => {
  it('generates a TOTP secret and a QR data URL', async () => {
    const { service } = makeService();
    const result = await service.generateTOTPEnrolment('u1', 'alice@example');
    expect(result.secret.secret).toMatch(/^[A-Z2-7]+$/i);
    expect(result.secret.otpauthUrl).toMatch(/^otpauth:\/\/totp/);
    expect(result.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  it('preserves the v1 setupTOTP shape for AuthService back-compat', async () => {
    const { service } = makeService();
    const result = await service.setupTOTP('u1');
    expect(result.verificationRequired).toBe(true);
    expect(result.secret).toBeDefined();
    expect(result.qrCode).toMatch(/^data:image\/png;base64,/);
  });
});

describe('MFAService — backup codes', () => {
  it('returns 10 plaintext codes and 10 persistable records', async () => {
    const { service } = makeService();
    const { plaintext, records } = await service.generateBackupCodes();
    expect(plaintext).toHaveLength(10);
    expect(records).toHaveLength(10);
    for (const code of plaintext) {
      // 16 chars, base32 alphabet.
      expect(code).toMatch(/^[A-Z2-7]{16}$/);
    }
    for (const rec of records) {
      expect(rec.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(rec.hash.startsWith('argon2id$')).toBe(true);
    }
  });

  it('plaintext codes are returned exactly once and not recoverable from records', async () => {
    const { service } = makeService();
    const { plaintext, records } = await service.generateBackupCodes();
    for (const rec of records) {
      // Hash is base64 of plaintext in our fake hasher; ensure that
      // the persisted record never accidentally embeds the plaintext
      // verbatim.
      for (const code of plaintext) {
        expect(rec.hash).not.toContain(code);
      }
    }
  });

  it('verifyBackupCode finds the right record via the fingerprint fast-path', async () => {
    const { service } = makeService();
    const { plaintext, records } = await service.generateBackupCodes();
    const target = plaintext[3]!;
    const result = await service.verifyBackupCode(target, records);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.consumedIndex).toBe(3);
  });

  it('rejects an unknown backup code', async () => {
    const { service } = makeService();
    const { records } = await service.generateBackupCodes();
    const result = await service.verifyBackupCode('NEVERVALIDXX1234', records);
    expect(result.ok).toBe(false);
  });

  it('replay of the same code is rejected once it has been removed from the set', async () => {
    const { service } = makeService();
    const { plaintext, records } = await service.generateBackupCodes();
    const consumed = plaintext[2]!;
    const first = await service.verifyBackupCode(consumed, records);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const remaining = records.filter((_, idx) => idx !== first.consumedIndex);
      const second = await service.verifyBackupCode(consumed, remaining);
      expect(second.ok).toBe(false);
    }
  });

  it('regenerateBackupCodes returns a fresh set distinct from the previous one', async () => {
    const { service } = makeService();
    const first = await service.regenerateBackupCodes('u1');
    const second = await service.regenerateBackupCodes('u1');
    const overlap = first.plaintext.filter((c) =>
      second.plaintext.includes(c)
    );
    expect(overlap).toHaveLength(0);
  });
});

describe('MFAService — TOTP', () => {
  it('verifies a freshly generated TOTP code', async () => {
    const { service } = makeService();
    const enrolment = await service.generateTOTPEnrolment('u1', 'u1');
    const code = speakeasy.totp({
      secret: enrolment.secret.secret,
      encoding: 'base32',
    });
    expect(service.verifyTOTP(enrolment.secret.secret, code)).toBe(true);
  });

  it('rejects a wrong TOTP code', async () => {
    const { service } = makeService();
    const enrolment = await service.generateTOTPEnrolment('u1', 'u1');
    expect(service.verifyTOTP(enrolment.secret.secret, '000000')).toBe(false);
  });

  it('verify() with method=totp emits success/failure events', async () => {
    const { service, events } = makeService();
    const enrolment = await service.generateTOTPEnrolment('u1', 'u1');
    const code = speakeasy.totp({
      secret: enrolment.secret.secret,
      encoding: 'base32',
    });
    const ok = await service.verify({
      userId: 'u1',
      request: { code, method: 'totp' },
      secret: enrolment.secret.secret,
      sessionId: 's1',
    });
    expect(ok.ok).toBe(true);
    expect(events.find((e) => e.type === 'iam.mfa.verification_success')).toBeDefined();

    const bad = await service.verify({
      userId: 'u1',
      request: { code: '111111', method: 'totp' },
      secret: enrolment.secret.secret,
      ipAddress: '10.0.0.1',
    });
    expect(bad.ok).toBe(false);
    expect(events.find((e) => e.type === 'iam.mfa.verification_failed')).toBeDefined();
  });

  it('verify() suppresses event emission when emitEvent=false', async () => {
    const { service, events } = makeService();
    const enrolment = await service.generateTOTPEnrolment('u1', 'u1');
    const code = speakeasy.totp({
      secret: enrolment.secret.secret,
      encoding: 'base32',
    });
    await service.verify({
      userId: 'u1',
      request: { code, method: 'totp' },
      secret: enrolment.secret.secret,
      emitEvent: false,
    });
    expect(events).toHaveLength(0);
  });
});

describe('MFAService — challenges (Redis round-trip)', () => {
  it('stores SMS challenge under noip:mfa:<userId>:sms with TTL', async () => {
    const { service, redis } = makeService();
    const challenge = await service.issueChallenge('u1', 'sms');
    const stored = await redis.get('noip:mfa:u1:sms');
    expect(stored).not.toBeNull();
    expect(challenge.code).toMatch(/^\d{6}$/);
  });

  it('verifyChallenge consumes the entry on success', async () => {
    const { service, redis } = makeService();
    const challenge = await service.issueChallenge('u1', 'email');
    const ok = await service.verifyChallenge('u1', 'email', challenge.code);
    expect(ok).toBe(true);
    expect(await redis.get('noip:mfa:u1:email')).toBeNull();
  });

  it('verifyChallenge consumes the entry on failure (single-use)', async () => {
    const { service, redis } = makeService();
    await service.issueChallenge('u1', 'email');
    const ok = await service.verifyChallenge('u1', 'email', '999999');
    expect(ok).toBe(false);
    expect(await redis.get('noip:mfa:u1:email')).toBeNull();
  });
});

describe('MFAService — rate limiting', () => {
  it('raises RateLimitError after the budget is exhausted', async () => {
    const { service } = makeService({ rateLimitMax: 3 });
    // 3 attempts allowed; the 4th should throw.
    for (let i = 0; i < 3; i += 1) {
      await service.verify({
        userId: 'u1',
        request: { code: '111111', method: 'totp' },
        secret: 'WRONGSECRETXX',
      });
    }
    await expect(
      service.verify({
        userId: 'u1',
        request: { code: '111111', method: 'totp' },
        secret: 'WRONGSECRETXX',
      })
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rate-limit counter is per-user', async () => {
    const { service } = makeService({ rateLimitMax: 1 });
    await service.verify({
      userId: 'a',
      request: { code: 'x', method: 'totp' },
      secret: 'WRONGSECRETXX',
    });
    // user b still has budget
    const result = await service.verify({
      userId: 'b',
      request: { code: 'x', method: 'totp' },
      secret: 'WRONGSECRETXX',
    });
    expect(result.ok).toBe(false);
    // user a is now over
    await expect(
      service.verify({
        userId: 'a',
        request: { code: 'x', method: 'totp' },
        secret: 'WRONGSECRETXX',
      })
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('MFAService — verifyCode legacy adapter', () => {
  it('delegates TOTP verification through verify()', async () => {
    const { service } = makeService();
    const enrolment = await service.generateTOTPEnrolment('u1', 'u1');
    const code = speakeasy.totp({
      secret: enrolment.secret.secret,
      encoding: 'base32',
    });
    const ok = await service.verifyCode('u1', code, false, {
      secret: enrolment.secret.secret,
    });
    expect(ok).toBe(true);
  });

  it('delegates backup-code verification', async () => {
    const { service } = makeService();
    const { plaintext, records } = await service.generateBackupCodes();
    const ok = await service.verifyCode('u1', plaintext[0]!, true, {
      backupCodes: records,
    });
    expect(ok).toBe(true);
  });

  it('returns false when no secret is supplied (fail-closed)', async () => {
    const { service } = makeService();
    const ok = await service.verifyCode('u1', '000000', false);
    expect(ok).toBe(false);
  });
});

describe('MFAService — fingerprint fast-path', () => {
  it('only invokes the Argon2 verifier on a fingerprint match', async () => {
    const fakeHasher = new FakeHasher();
    const verifySpy = jest.spyOn(fakeHasher, 'verifyPassword');
    const service = new MFAService({
      redis: new MemoryRedis(),
      clock: { now: () => new Date() },
      hasher: fakeHasher,
      logger: silentLogger,
      config: { rateLimitMax: 100 },
    });
    const { records } = await service.generateBackupCodes();
    verifySpy.mockClear();
    // Try a code that cannot match any fingerprint
    await service.verifyBackupCode('ZZZZZZZZZZZZZZZZ', records);
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

describe('MFAService — record persistence shape', () => {
  it('records carry both an 8-hex fingerprint and an Argon2-style hash', async () => {
    const { service } = makeService();
    const { records } = await service.generateBackupCodes();
    for (const rec of records as BackupCodeRecord[]) {
      expect(rec.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(rec.hash.length).toBeGreaterThan(8);
    }
  });
});
