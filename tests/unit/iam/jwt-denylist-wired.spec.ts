// Integration-style test for the AuthService → JWTManager → Redis
// denylist wireup (deferred follow-up from Phase 1 wave 3).
//
// We construct a fully-wired AuthService with a stubbed shared Redis
// client and assert that:
//   - issuing a token does NOT touch the deny namespace;
//   - calling `logout(... , { accessToken, refreshToken })` writes
//     entries under `noip:deny:<jti>` for both tokens;
//   - subsequent `verifyToken(...)` against the same access token
//     returns `null` because the manager hits the deny entry first.
//
// The `_redis-stub.ts` fake matches the `RedisLike` surface the
// JWTManager actually consumes, so we exercise the production code
// path end-to-end without a real Redis.

import { JWTManager } from '../../../src/utils/auth/jwt.manager';
import { MFAService } from '../../../src/utils/auth/mfa.service';
import type {
  EmailService,
  DeviceFingerprintService,
  PasswordService,
} from '../../../src/utils/auth';
import { AuthService } from '../../../src/services/auth.service';
import { FakeRedis } from './_redis-stub';

// The production EmailService eagerly constructs a real Nodemailer
// transport (and trips on a pre-existing typo against the @types).
// We pass a stub via DI so the constructor never reaches it.
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
  const session = {
    save: jest.fn(async () => undefined),
    revoke: jest.fn(async () => undefined),
    updateLastActivity: jest.fn(async () => undefined),
  };
  function SessionCtor(_input: unknown): unknown {
    return session;
  }
  (SessionCtor as unknown as Record<string, unknown>)['findOne'] = jest.fn(
    async () => session
  );
  return {
    UserModel: { findOne: jest.fn(), findById: jest.fn() },
    SessionModel: SessionCtor,
    SecurityEventModel: { createEvent: jest.fn(async () => undefined) },
    RoleModel: { findOne: jest.fn(async () => null) },
    PermissionModel: { findOne: jest.fn(async () => null) },
    AuditLogModel: {},
  };
});

const claims = {
  sub: 'user-77',
  username: 'wireup',
  email: 'wireup@example.com',
  roles: ['user'],
  permissions: ['user:read:own'],
  sessionId: 'sess-W',
};

function buildAuthService(): { service: AuthService; redis: FakeRedis } {
  const redis = new FakeRedis();
  const jwtManager = new JWTManager({
    activeKey: {
      kid: 'kid-wire',
      secret: 'jwt-denylist-wire-secret-min-32-chars-long-pad!',
    },
    accessExpirySec: 60,
    refreshExpirySec: 3600,
    redis,
  });
  // We still pass an MFAService so the constructor takes the explicit
  // path instead of synthesising one. The MFA stub is irrelevant for
  // this test (logout doesn't touch it), so we pass the bare default.
  const mfaService = new MFAService();
  const service = new AuthService({
    jwtManager,
    mfaService,
    emailService: buildEmailStub(),
    passwordService: buildPasswordStub(),
    deviceFingerprintService: buildFingerprintStub(),
  });
  return { service, redis };
}

describe('AuthService → JWTManager Redis denylist wiring', () => {
  it('logout writes the access + refresh jtis into noip:deny:*', async () => {
    const { service, redis } = buildAuthService();
    const jwt = service.getJwtManager();

    // Mint a token pair via the wired JWT manager so the test exercises
    // the real signing path. createTokenPair binds a shared family to
    // both tokens; revoking the refresh marks the family.
    const pair = await jwt.createTokenPair(claims);
    expect(await jwt.isTokenRevoked(pair.accessToken)).toBe(false);

    await service.logout('user-77', 'sess-W', {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    });

    // The deny namespace now has entries for both jtis.
    const accessPayload = (await jwt.decodeToken(pair.accessToken)) as {
      jti: string;
    } | null;
    const refreshPayload = (await jwt.decodeToken(pair.refreshToken)) as {
      jti: string;
    } | null;
    expect(accessPayload?.jti).toBeTruthy();
    expect(refreshPayload?.jti).toBeTruthy();

    expect(redis.raw(`noip:deny:${accessPayload!.jti}`)).toBeDefined();
    expect(redis.raw(`noip:deny:${refreshPayload!.jti}`)).toBeDefined();
    // Family state for the refresh token is also written (revocation
    // implicitly closes the whole family per ADR-0006).
    expect(redis.raw(`noip:fam:${pair.family}`)).toBeDefined();
  });

  it('verifyToken returns null after logout because the deny entry is hit', async () => {
    const { service } = buildAuthService();
    const jwt = service.getJwtManager();
    const pair = await jwt.createTokenPair(claims);

    expect(await jwt.verifyToken(pair.accessToken, 'access')).not.toBeNull();
    await service.logout('user-77', 'sess-W', {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    });
    expect(await jwt.verifyToken(pair.accessToken, 'access')).toBeNull();
  });

  it('isTokenRevoked flips to true once the denylist entry lands', async () => {
    const { service } = buildAuthService();
    const jwt = service.getJwtManager();
    const access = await jwt.signToken(claims, 'access');
    expect(await jwt.isTokenRevoked(access)).toBe(false);
    await service.logout('user-77', 'sess-W', { accessToken: access });
    expect(await jwt.isTokenRevoked(access)).toBe(true);
  });
});
