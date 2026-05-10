// Posture scorer — pure domain service.
//
// Converts a list of findings into a 0–100 security score. Default
// weights:
//   critical = 20, high = 10, medium = 4, low = 1
// Total deductions are capped at 100 so the score floor is always 0.
// Findings whose status is `resolved` or `suppressed` do not deduct.
//
// The breakdown returns the per-severity deduction (post-cap) so the
// dashboard can render the contribution stack.

import type { Severity } from './value-objects';

export interface PostureWeights {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_WEIGHTS: PostureWeights = {
  critical: 20,
  high: 10,
  medium: 4,
  low: 1,
};

export interface PostureScoreResult {
  score: number;
  breakdown: PostureWeights;
}

export interface ScorableFinding {
  severity: Severity;
  status: 'open' | 'acknowledged' | 'suppressed' | 'resolved';
}

export class PostureScorer {
  constructor(private readonly weights: PostureWeights = DEFAULT_WEIGHTS) {}

  score(findings: ReadonlyArray<ScorableFinding>): PostureScoreResult {
    const counts: PostureWeights = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      // Only open + acknowledged findings deduct from the score.
      if (f.status === 'resolved' || f.status === 'suppressed') continue;
      switch (f.severity) {
        case 'critical':
          counts.critical += this.weights.critical;
          break;
        case 'high':
          counts.high += this.weights.high;
          break;
        case 'medium':
          counts.medium += this.weights.medium;
          break;
        case 'low':
          counts.low += this.weights.low;
          break;
      }
    }
    const rawDeduction =
      counts.critical + counts.high + counts.medium + counts.low;
    const cappedDeduction = Math.min(100, rawDeduction);
    // Once we are at the cap, scale individual buckets so their
    // breakdown still sums to the actual deduction (preserves the
    // dashboard's stack-area contract).
    if (rawDeduction > 100 && rawDeduction > 0) {
      const scale = cappedDeduction / rawDeduction;
      counts.critical = Math.round(counts.critical * scale);
      counts.high = Math.round(counts.high * scale);
      counts.medium = Math.round(counts.medium * scale);
      // The low bucket absorbs any rounding drift so the breakdown
      // still sums to cappedDeduction exactly.
      counts.low =
        cappedDeduction - counts.critical - counts.high - counts.medium;
      if (counts.low < 0) counts.low = 0;
    }
    const score = Math.max(0, Math.min(100, 100 - cappedDeduction));
    return { score: Math.round(score), breakdown: counts };
  }
}
