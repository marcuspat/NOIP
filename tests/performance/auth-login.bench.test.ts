// Informational benchmark for the AuthService login hot path.
//
// We can't easily spin up the full Mongoose-backed login here, so we
// bench the *credential validation + token mint + denylist write* core
// — the parts that dominate latency in production. The full path adds
// one Mongo lookup and one session insert, which are measured by other
// suites.
//
// Asserts nothing about absolute timings (machine-dependent); the
// printed line is the artefact the CI dashboard tracks for regressions.

import { JWTManager } from '../../src/utils/auth/jwt.manager';
import {
  MFAService,
  type MFARedisClient,
} from '../../src/utils/auth/mfa.service';
import { FakeRedis } from '../unit/iam/_redis-stub';

interface Sample {
  verifyPasswordMs: number;
  signTokensMs: number;
  totalMs: number;
}

interface Summary {
  count: number;
  p50: number;
  p95: number;
  mean: number;
}

class NoopMFARedis implements MFARedisClient {
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<unknown> {
    return 'OK';
  }
  async del(): Promise<unknown> {
    return 1;
  }
  async incr(): Promise<number> {
    return 1;
  }
  async expire(): Promise<unknown> {
    return 1;
  }
  async ttl(): Promise<number> {
    return 60;
  }
}

/**
 * Argon2id is intentionally slow; the bench uses a fixed pre-hashed
 * value plus a synthetic verifier so the timing reflects the JWT path
 * (which is what the AuthService composition root changed), not the
 * password verifier cost (covered by mfa-verify.bench.test.ts).
 */
class FastHasher {
  private readonly map = new Map<string, string>();
  async hashPassword(p: string): Promise<string> {
    const h = `h:${p}`;
    this.map.set(p, h);
    return h;
  }
  async verifyPassword(p: string, h: string): Promise<boolean> {
    return h === `h:${p}`;
  }
}

function summarise(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: p(0.5),
    p95: p(0.95),
    mean: total / sorted.length,
  };
}

describe('AuthService login bench (token mint + verify + denylist)', () => {
  jest.setTimeout(120_000);

  it('measures 1000 mint-then-verify cycles against a stubbed Redis', async () => {
    const redis = new FakeRedis();
    const jwt = new JWTManager({
      activeKey: {
        kid: 'kid-bench-login',
        secret: 'auth-login-bench-secret-min-32-chars-long-pad!',
      },
      accessExpirySec: 900,
      refreshExpirySec: 7 * 24 * 3600,
      redis,
    });
    const hasher = new FastHasher();
    const mfa = new MFAService({ redis: new NoopMFARedis(), hasher });
    // Touch `mfa` to silence unused-warning linters and confirm it
    // composes without throwing — the production composition root
    // builds it eagerly the same way.
    expect(mfa).toBeDefined();

    // Pre-stage the user's stored hash.
    const password = 'corr-horse-battery-staple';
    const stored = await hasher.hashPassword(password);

    const samples: Sample[] = [];

    // Warm up so the JIT + SecretKey import are amortised.
    for (let i = 0; i < 25; i += 1) {
      await hasher.verifyPassword(password, stored);
      await jwt.createTokenPair({
        sub: 'warm',
        username: 'w',
        email: 'w@x',
        roles: [],
        permissions: [],
        sessionId: 'sess-w',
      });
    }

    const iterations = 1000;
    for (let i = 0; i < iterations; i += 1) {
      const tVerifyStart = process.hrtime.bigint();
      await hasher.verifyPassword(password, stored);
      const tVerifyEnd = process.hrtime.bigint();

      const tSignStart = process.hrtime.bigint();
      const pair = await jwt.createTokenPair({
        sub: `user-${i}`,
        username: 'bench',
        email: 'b@x',
        roles: ['user'],
        permissions: [],
        sessionId: `sess-${i}`,
      });
      const tSignEnd = process.hrtime.bigint();

      // Touch the access token so the optimizer can't hoist the mint
      // call out of the loop.
      expect(pair.accessToken.length).toBeGreaterThan(20);

      samples.push({
        verifyPasswordMs: Number(tVerifyEnd - tVerifyStart) / 1e6,
        signTokensMs: Number(tSignEnd - tSignStart) / 1e6,
        totalMs:
          (Number(tVerifyEnd - tVerifyStart) + Number(tSignEnd - tSignStart)) /
          1e6,
      });
    }

    const passSummary = summarise(samples.map(s => s.verifyPasswordMs));
    const signSummary = summarise(samples.map(s => s.signTokensMs));
    const totalSummary = summarise(samples.map(s => s.totalMs));

    console.log(
      `[bench] auth-login.verifyPassword: count=${passSummary.count} mean=${passSummary.mean.toFixed(3)}ms p50=${passSummary.p50.toFixed(3)}ms p95=${passSummary.p95.toFixed(3)}ms`
    );
    console.log(
      `[bench] auth-login.signTokens:    count=${signSummary.count} mean=${signSummary.mean.toFixed(3)}ms p50=${signSummary.p50.toFixed(3)}ms p95=${signSummary.p95.toFixed(3)}ms`
    );
    console.log(
      `[bench] auth-login.total:         count=${totalSummary.count} mean=${totalSummary.mean.toFixed(3)}ms p50=${totalSummary.p50.toFixed(3)}ms p95=${totalSummary.p95.toFixed(3)}ms`
    );
  });
});
