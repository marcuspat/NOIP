// PatternLearner — recurrence threshold, reinforcement vs weakening,
// soft-delete on confidence drop.

import { PatternLearner } from '../../../src/contexts/ai/application/pattern-learner';
import { InMemoryLearningPatternRepository } from '../../../src/contexts/ai/infrastructure/persistence/learning-pattern.repository';
import {
  FixedClock,
  InMemoryEventBus,
  type DomainEvent,
} from '../../../src/shared/kernel';
import type { Insight } from '../../../src/contexts/ai/domain/value-objects';

function makeLearner(threshold = 3): {
  learner: PatternLearner;
  repo: InMemoryLearningPatternRepository;
  events: DomainEvent<unknown>[];
} {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const repo = new InMemoryLearningPatternRepository();
  const events: DomainEvent<unknown>[] = [];
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  bus.subscribe('ai.*', e => events.push(e));
  const learner = new PatternLearner({
    patterns: repo,
    bus,
    clock,
    recurrenceThreshold: threshold,
  });
  return { learner, repo, events };
}

describe('PatternLearner', () => {
  it('creates a LearningPattern after the recurrence threshold', async () => {
    const { learner, repo, events } = makeLearner(3);
    const insight: Insight = {
      text: 'Privileged container detected in default ns',
      supportingContextIds: [],
      severity: 'high',
    };
    await learner.observeInsights({ type: 'security', insights: [insight] });
    await learner.observeInsights({ type: 'security', insights: [insight] });
    await learner.observeInsights({ type: 'security', insights: [insight] });
    const patterns = await repo.listByType('security');
    expect(patterns.length).toBe(1);
    expect(events.some(e => e.type === 'ai.pattern.learned')).toBe(true);
  });

  it('reinforce() updates successRate; weaken() does not', async () => {
    const { learner, repo } = makeLearner(1);
    const insight: Insight = {
      text: 'rbac is wide open',
      supportingContextIds: [],
      severity: 'medium',
    };
    await learner.observeInsights({ type: 'security', insights: [insight] });
    const created = (await repo.listByType('security'))[0]!;
    await learner.reinforce(created.id);
    const after1 = await repo.findById(created.id);
    expect(after1?.successRate).toBeCloseTo(1.0);
    await learner.weaken(created.id);
    const after2 = await repo.findById(created.id);
    expect(after2?.successRate).toBeCloseTo(after1!.successRate);
  });

  it('soft-deletes when confidence falls below the threshold', async () => {
    const { learner, repo } = makeLearner(1);
    const insight: Insight = {
      text: 'misconfigured deployment',
      supportingContextIds: [],
      severity: 'medium',
    };
    await learner.observeInsights({ type: 'security', insights: [insight] });
    const created = (await repo.listByType('security'))[0]!;
    // Force confidence below threshold via 4 weakens (start 0.6).
    await learner.weaken(created.id);
    await learner.weaken(created.id);
    await learner.weaken(created.id);
    await learner.weaken(created.id);
    const found = await repo.findById(created.id);
    expect(found?.isDeprecated).toBe(true);
  });

  it('signature normalises ids + numbers so duplicates collapse', () => {
    const { learner } = makeLearner();
    const a = learner.signatureFor('Pod web-7 had error 42');
    const b = learner.signatureFor('Pod web-99 had error 7');
    expect(a).toBe(b);
  });
});
