// MFA verification benchmark (ADR-0009).
//
// Two scenarios:
//   1. 1000 TOTP verifications.
//   2. 1000 backup-code verifications.
//
// We use the production Argon2id-backed PasswordService so the timings
// reflect real cost. The bench prints p50 / p95 / mean per kind. It
// does not assert thresholds — it is informational and intended for
// trend-tracking via CI artefacts.

import speakeasy from 'speakeasy';
import { MFAService } from '../../src/utils/auth/mfa.service';
import { PasswordService } from '../../src/utils/auth/password.service';

interface BenchSummary {
  kind: string;
  count: number;
  p50: number;
  p95: number;
  mean: number;
  total: number;
}

class NoopRedis {
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

const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

function summarise(kind: string, samples: number[]): BenchSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    kind,
    count: sorted.length,
    p50: p(0.5),
    p95: p(0.95),
    mean: total / sorted.length,
    total,
  };
}

function printSummary(s: BenchSummary): void {
  console.log(
    `[bench] ${s.kind}: count=${s.count} mean=${s.mean.toFixed(3)}ms p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms total=${s.total.toFixed(1)}ms`
  );
}

describe('MFA verify benchmark', () => {
  jest.setTimeout(600_000);

  it('measures 1000 TOTP and 1000 backup-code verifications', async () => {
    const service = new MFAService({
      redis: new NoopRedis(),
      clock: { now: () => new Date() },
      hasher: new PasswordService(),
      logger: silentLogger,
      config: {
        rateLimitMax: Number.POSITIVE_INFINITY,
        rateLimitWindowSec: 60,
      },
    });

    const enrolment = await service.generateTOTPEnrolment('bench', 'bench');
    const totpSecret = enrolment.secret.secret;
    const totpCode = speakeasy.totp({
      secret: totpSecret,
      encoding: 'base32',
    });

    const totpSamples: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const t0 = performance.now();
      service.verifyTOTP(totpSecret, totpCode);
      totpSamples.push(performance.now() - t0);
    }

    // Note: backup-code generation uses real Argon2 (slow); shrink to
    // a smaller, fixed set so bench runtime is reasonable but the
    // verify path is exercised the full 1000 times.
    const { plaintext, records } = await service.generateBackupCodes();
    const backupSamples: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const target = plaintext[i % plaintext.length]!;
      const t0 = performance.now();
      await service.verifyBackupCode(target, records);
      backupSamples.push(performance.now() - t0);
    }

    printSummary(summarise('totp-verify', totpSamples));
    printSummary(summarise('backup-verify', backupSamples));

    // No assertions — bench is informational.
    expect(totpSamples).toHaveLength(1000);
    expect(backupSamples).toHaveLength(1000);
  });
});
