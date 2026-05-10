// AIContext aggregate invariants.

import {
  AIContext,
  contextIdFor,
} from '../../../src/contexts/ai/domain/ai-context';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('AIContext aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('id is sha256(content) — ingestion is idempotent by content', () => {
    const a = AIContext.ingest(
      {
        type: 'incident',
        content: 'cluster X had a privileged escape',
        source: 'audit',
      },
      clock
    );
    expect(a.id.startsWith('sha256:')).toBe(true);
    expect(a.id).toBe(contextIdFor('cluster X had a privileged escape'));
  });

  it('rejects empty content', () => {
    expect(() =>
      AIContext.ingest({ type: 'general', content: '', source: 'x' }, clock)
    ).toThrow(ValidationError);
  });

  it('emits ai.context.ingested on ingest', () => {
    const a = AIContext.ingest(
      { type: 'general', content: 'hello', source: 's' },
      clock
    );
    const events = a.drainEvents();
    expect(events[0]?.type).toBe('ai.context.ingested');
  });

  it('emits ai.context.retired on retire (idempotent)', () => {
    const a = AIContext.ingest(
      { type: 'general', content: 'x', source: 's' },
      clock
    );
    a.drainEvents();
    a.retire('compaction', clock);
    a.retire('compaction', clock); // second retire is a no-op
    const events = a.drainEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe('ai.context.retired');
  });

  it('round-trips via persistence', () => {
    const a = AIContext.ingest(
      {
        type: 'compliance',
        content: 'control fail x',
        source: 'audit',
        confidence: 0.7,
        metadata: { framework: 'SOC2' },
      },
      clock
    );
    const restored = AIContext.fromPersistence(a.toPersistence());
    expect(restored.id).toBe(a.id);
    expect(restored.metadata['framework']).toBe('SOC2');
  });
});
