// Integration-style test for the AuthService → MFAService → Redis
// challenge wireup (deferred follow-up from Phase 1 wave 3).
//
// We construct AuthService with an explicit MFAService backed by a
// memory `MFARedisClient` stub and assert that issuing an SMS / email
// challenge writes the expected `noip:mfa:<userId>:<method>` key with
// the configured TTL.

import {
  MFAService,
  type MFARedisClient,
} from '../../../src/utils/auth/mfa.service';
import type {
  EmailService,
  PasswordService,
  DeviceFingerprintService,
} from '../../../src/utils/auth';
import { AuthService } from '../../../src/services/auth.service';

function buildEmailStub(): EmailService {
  return {
    sendVerificationEmail: async (): Promise<void> => undefined,
    sendPasswordResetEmail: async (): Promise<void> => undefined,
  } as unknown as EmailService;
}

function buildPasswordStub(): PasswordService {
  return {
    validatePasswordStrength: (): boolean => true,
    hashPassword: async (p: string): Promise<string> => `h:${p}`,
    verifyPassword: async (p: string, h: string): Promise<boolean> =>
      h === `h:${p}`,
  } as unknown as PasswordService;
}

function buildFingerprintStub(): DeviceFingerprintService {
  return {
    generateFingerprint: (): string => 'fp-test',
    extractDeviceInfo: (): Record<string, unknown> => ({}),
  } as unknown as DeviceFingerprintService;
}

jest.mock('../../../src/models', () => {
  return {
    UserModel: { findOne: jest.fn(), findById: jest.fn() },
    SessionModel: function (): unknown {
      return {};
    },
    SecurityEventModel: { createEvent: jest.fn(async () => undefined) },
    RoleModel: { findOne: jest.fn(async () => null) },
    PermissionModel: { findOne: jest.fn(async () => null) },
    AuditLogModel: {},
  };
});

class MemoryMFARedis implements MFARedisClient {
  public readonly setCalls: Array<{
    key: string;
    value: string;
    mode?: 'EX';
    seconds?: number;
  }> = [];
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
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
    const call: { key: string; value: string; mode?: 'EX'; seconds?: number } =
      {
        key,
        value,
      };
    if (mode !== undefined) call.mode = mode;
    if (seconds !== undefined) call.seconds = seconds;
    this.setCalls.push(call);
    const expiresAt =
      mode === 'EX' && typeof seconds === 'number'
        ? Date.now() + seconds * 1000
        : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
  async incr(key: string): Promise<number> {
    const e = this.store.get(key);
    const n = (e ? Number(e.value) || 0 : 0) + 1;
    this.store.set(key, {
      value: String(n),
      expiresAt: e?.expiresAt ?? null,
    });
    return n;
  }
  async expire(key: string, seconds: number): Promise<unknown> {
    const e = this.store.get(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }
  async ttl(key: string): Promise<number> {
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }
  ttlSync(key: string): number {
    const e = this.store.get(key);
    if (!e || e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }
  rawValue(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
}

describe('AuthService → MFAService Redis challenge wiring', () => {
  it('issuing an SMS challenge lands at noip:mfa:<userId>:sms with the configured TTL', async () => {
    const redis = new MemoryMFARedis();
    const mfa = new MFAService({
      redis,
      config: { challengeTtlSec: 180 },
    });
    const service = new AuthService({
      mfaService: mfa,
      emailService: buildEmailStub(),
      passwordService: buildPasswordStub(),
      deviceFingerprintService: buildFingerprintStub(),
    });

    const result = await service
      .getMfaService()
      .issueChallenge('user-42', 'sms');

    expect(result.code).toMatch(/^\d{6}$/);
    const key = 'noip:mfa:user-42:sms';
    expect(redis.rawValue(key)).toBeDefined();
    expect(redis.setCalls.at(-1)).toMatchObject({
      key,
      mode: 'EX',
      seconds: 180,
    });
    const ttl = redis.ttlSync(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(180);
  });

  it('issuing an email challenge lands at noip:mfa:<userId>:email', async () => {
    const redis = new MemoryMFARedis();
    const mfa = new MFAService({
      redis,
      config: { challengeTtlSec: 300 },
    });
    const service = new AuthService({
      mfaService: mfa,
      emailService: buildEmailStub(),
      passwordService: buildPasswordStub(),
      deviceFingerprintService: buildFingerprintStub(),
    });

    await service.getMfaService().issueChallenge('user-99', 'email');
    expect(redis.rawValue('noip:mfa:user-99:email')).toBeDefined();
  });

  it('the synthesised MFA service uses the supplied Redis when no mfaService is passed', async () => {
    const redis = new MemoryMFARedis();
    const service = new AuthService({
      emailService: buildEmailStub(),
      passwordService: buildPasswordStub(),
      deviceFingerprintService: buildFingerprintStub(),
      redis: {
        // RedisLike satisfiers (unused on the MFA hot path but typed).
        setEx: jest.fn(async () => undefined),
        get: jest.fn(async () => null),
        mget: jest.fn(async () => []),
        del: jest.fn(async () => undefined),
        // MFARedisClient surface — what we actually exercise.
        set: redis.set.bind(redis),
        incr: redis.incr.bind(redis),
        expire: redis.expire.bind(redis),
        ttl: redis.ttl.bind(redis),
      } as unknown as NonNullable<
        ConstructorParameters<typeof AuthService>[0]
      >['redis'],
    });
    await service.getMfaService().issueChallenge('user-z', 'sms');
    expect(redis.rawValue('noip:mfa:user-z:sms')).toBeDefined();
  });
});
