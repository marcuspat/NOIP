import { IReasoningBank } from './ports';

interface ExperienceRecord {
  contextKey: string;
  strategy: { id: string; description: string };
  outcome: { success: boolean; notes?: string };
  /** Monotonic insertion sequence — used as a recency tiebreaker. */
  seq: number;
}

interface StrategyStats {
  strategy: { id: string; description: string };
  success: number;
  total: number;
  /** seq of the most recent experience for this strategy. */
  lastSeq: number;
}

/**
 * In-memory `IReasoningBank` implementation.
 *
 * `recommendStrategy` ranks strategies seen for a given context, using
 * Laplace-smoothed success rate `(success + 1) / (total + 2)`. Smoothing
 * means a strategy that has been tried once and failed still surfaces
 * (weight 1/3), and lets us keep returning candidates even with sparse
 * data. Ties are broken by recency (higher `lastSeq` wins) so the
 * freshest strategy bubbles up.
 *
 * Contexts are matched by `JSON.stringify(context)`; structurally
 * identical contexts therefore dedupe into one bucket. We do not attempt
 * key-order normalisation — callers should pass canonical context shapes.
 */
export class MockReasoningBank implements IReasoningBank {
  private experiences: ExperienceRecord[] = [];
  private seq = 0;

  async recordExperience(input: {
    context: unknown;
    strategy: { id: string; description: string };
    outcome: { success: boolean; notes?: string };
  }): Promise<void> {
    this.experiences.push({
      contextKey: JSON.stringify(input.context),
      strategy: { ...input.strategy },
      outcome: { ...input.outcome },
      seq: ++this.seq,
    });
  }

  async recommendStrategy(
    context: unknown
  ): Promise<
    Array<{ strategy: { id: string; description: string }; weight: number }>
  > {
    const key = JSON.stringify(context);
    const byStrategyId = new Map<string, StrategyStats>();

    for (const exp of this.experiences) {
      if (exp.contextKey !== key) continue;
      const existing = byStrategyId.get(exp.strategy.id);
      if (existing) {
        existing.total += 1;
        if (exp.outcome.success) existing.success += 1;
        if (exp.seq > existing.lastSeq) existing.lastSeq = exp.seq;
      } else {
        byStrategyId.set(exp.strategy.id, {
          strategy: exp.strategy,
          success: exp.outcome.success ? 1 : 0,
          total: 1,
          lastSeq: exp.seq,
        });
      }
    }

    const ranked = Array.from(byStrategyId.values()).map(s => ({
      strategy: s.strategy,
      weight: (s.success + 1) / (s.total + 2),
      lastSeq: s.lastSeq,
    }));

    ranked.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return b.lastSeq - a.lastSeq;
    });

    return ranked.map(({ strategy, weight }) => ({ strategy, weight }));
  }

  async count(): Promise<number> {
    return this.experiences.length;
  }
}
