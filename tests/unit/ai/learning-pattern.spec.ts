// LearningPattern aggregate invariants.

import { LearningPattern } from '../../../src/contexts/ai/domain/learning-pattern';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('LearningPattern aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  function create(): LearningPattern {
    return LearningPattern.create(
      {
        type: 'security',
        pattern: 'Privileged container detected',
        signature: 'sha1:abc',
        confidence: 0.6,
      },
      clock
    );
  }

  it('emits ai.pattern.learned on creation', () => {
    const p = create();
    const events = p.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('ai.pattern.learned');
  });

  it('rejects empty pattern + signature', () => {
    expect(() =>
      LearningPattern.create({ type: 't', pattern: '', signature: 'x' }, clock)
    ).toThrow(ValidationError);
    expect(() =>
      LearningPattern.create({ type: 't', pattern: 'p', signature: '' }, clock)
    ).toThrow(ValidationError);
  });

  it('observe() bumps usage + small confidence bump only (no successRate change)', () => {
    const p = create();
    p.observe(clock);
    expect(p.usageCount).toBe(1);
    expect(p.successRate).toBe(0);
  });

  it('reinforce() updates successRate (DDD-08 invariant)', () => {
    const p = create();
    p.reinforce(clock);
    p.reinforce(clock);
    expect(p.reinforcementCount).toBe(2);
    expect(p.successRate).toBeCloseTo(1.0);
  });

  it('weaken() drops confidence; does NOT update successRate', () => {
    const p = create();
    p.reinforce(clock);
    const successBefore = p.successRate;
    p.weaken(clock, 0.0); // threshold low so no soft-delete
    expect(p.weakeningCount).toBe(1);
    expect(p.successRate).toBe(successBefore);
    expect(p.confidence).toBeLessThan(0.65);
  });

  it('soft-deletes on confidence drop below threshold', () => {
    const p = create();
    // Start at 0.6 so 4 weakens of 0.1 sends us under 0.3.
    p.weaken(clock);
    p.weaken(clock);
    p.weaken(clock);
    p.weaken(clock);
    expect(p.isDeprecated).toBe(true);
    const events = p.drainEvents();
    expect(events.some(e => e.type === 'ai.pattern.deprecated')).toBe(true);
  });

  it('round-trips via persistence', () => {
    const p = create();
    const restored = LearningPattern.fromPersistence(p.toPersistence());
    expect(restored.id).toBe(p.id);
    expect(restored.signature).toBe('sha1:abc');
    expect(restored.confidence).toBeCloseTo(0.6);
  });
});
