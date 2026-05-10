// PostureScorer — deduction math.

import {
  PostureScorer,
  DEFAULT_WEIGHTS,
} from '../../../src/contexts/security/domain/posture-scorer';

describe('PostureScorer', () => {
  it('returns 100 with no findings', () => {
    const r = new PostureScorer().score([]);
    expect(r.score).toBe(100);
    expect(r.breakdown).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('sums weighted deductions', () => {
    const r = new PostureScorer().score([
      { severity: 'critical', status: 'open' },
      { severity: 'high', status: 'open' },
      { severity: 'medium', status: 'open' },
      { severity: 'low', status: 'open' },
    ]);
    // 20 + 10 + 4 + 1 = 35; score = 65.
    expect(r.score).toBe(65);
    expect(r.breakdown).toEqual({
      critical: DEFAULT_WEIGHTS.critical,
      high: DEFAULT_WEIGHTS.high,
      medium: DEFAULT_WEIGHTS.medium,
      low: DEFAULT_WEIGHTS.low,
    });
  });

  it('does not deduct for resolved or suppressed findings', () => {
    const r = new PostureScorer().score([
      { severity: 'critical', status: 'resolved' },
      { severity: 'critical', status: 'suppressed' },
    ]);
    expect(r.score).toBe(100);
  });

  it('deducts for acknowledged findings (still active)', () => {
    const r = new PostureScorer().score([
      { severity: 'high', status: 'acknowledged' },
    ]);
    expect(r.score).toBe(100 - DEFAULT_WEIGHTS.high);
  });

  it('caps deduction at 100', () => {
    const findings = Array.from({ length: 50 }, () => ({
      severity: 'critical' as const,
      status: 'open' as const,
    }));
    const r = new PostureScorer().score(findings);
    expect(r.score).toBe(0);
    const sum =
      r.breakdown.critical +
      r.breakdown.high +
      r.breakdown.medium +
      r.breakdown.low;
    expect(sum).toBe(100);
  });

  it('honours custom weights', () => {
    const r = new PostureScorer({
      critical: 50,
      high: 20,
      medium: 10,
      low: 2,
    }).score([{ severity: 'critical', status: 'open' }]);
    expect(r.score).toBe(50);
  });
});
