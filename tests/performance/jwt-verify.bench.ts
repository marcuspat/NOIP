// Informational benchmark for the JWT verification hot path.
//
// Measures p50/p95 latency of `JWTManager.verifyToken` against a warm
// in-process Redis stub over 1k iterations. Prints a single-line summary
// and asserts only that the run completed — absolute numbers are
// machine-dependent and not part of the contract. The intent is to
// catch a future regression (e.g. accidentally re-importing the
// SecretKey on every verify) without flaking on slow CI.

import { JWTManager } from '../../src/utils/auth/jwt.manager';
import { FakeRedis } from '../unit/iam/_redis-stub';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx]!;
}

describe('JWT verify benchmark', () => {
  it('measures p50/p95 verification latency', async () => {
    const redis = new FakeRedis();
    const m = new JWTManager({
      activeKey: {
        kid: 'kid-bench',
        secret: 'bench-secret-must-be-at-least-32-chars-long!!!',
      },
      accessExpirySec: 600,
      refreshExpirySec: 7 * 24 * 3600,
      redis,
    });

    const token = await m.signToken(
      {
        sub: 'user-bench',
        username: 'bench',
        email: 'bench@example.com',
        roles: ['user'],
        permissions: [],
        sessionId: 'sess-bench',
      },
      'access'
    );

    const iterations = 1000;
    const samples: number[] = [];

    // Warm up so JIT + first-time SecretKey import don't skew p50.
    for (let i = 0; i < 50; i++) {
      await m.verifyToken(token, 'access');
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint();
      await m.verifyToken(token, 'access');
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    // Single-line summary, machine-readable for CI dashboards.

    console.log(
      `[jwt-verify-bench] iterations=${iterations} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms mean=${mean.toFixed(3)}ms`
    );

    // Sanity assertion only — absolute numbers are machine-dependent.
    expect(samples).toHaveLength(iterations);
  });
});
