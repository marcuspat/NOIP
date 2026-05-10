// FeedbackService — feedback updates pattern, events published.

import {
  composeAI,
  InMemoryAnalysisRepository,
  InMemoryLearningPatternRepository,
  InMemoryAIContextProjectionRepository,
  InMemoryRagStore,
  NoOpIngestionBridge,
  AnthropicAdapter,
} from '../../../src/contexts/ai/api';
import {
  FixedClock,
  InMemoryEventBus,
  newId,
  type ClusterId,
  type DomainEvent,
} from '../../../src/shared/kernel';
import { LearningPattern } from '../../../src/contexts/ai/domain/learning-pattern';

describe('FeedbackService', () => {
  it('reinforces the matching LearningPattern on positive feedback', async () => {
    const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const events: DomainEvent<unknown>[] = [];
    bus.subscribe('ai.*', e => events.push(e));
    const composed = composeAI({
      bus,
      clock,
      llmClient: new AnthropicAdapter({ clock }),
      ragStore: new InMemoryRagStore(),
      ingestion: new NoOpIngestionBridge(),
      repos: {
        analyses: new InMemoryAnalysisRepository(),
        patterns: new InMemoryLearningPatternRepository(),
        contexts: new InMemoryAIContextProjectionRepository(),
      },
    });

    const cluster = newId<ClusterId>();
    const analysis = await composed.service.analyzeSecurity({
      scope: { clusterId: cluster },
      payload: { issue: 'config drift detected' },
    });

    // Manually plant a pattern that matches the analysis insight signature.
    const sig = composed.patternLearner.signatureFor(
      analysis.insights[0]?.text ?? 'x'
    );
    const planted = LearningPattern.create(
      {
        type: analysis.type,
        pattern: 'planted',
        signature: sig,
        confidence: 0.6,
      },
      clock
    );
    // Save via the in-memory repo (cast through the composed bundle).
    const repo = (
      composed as unknown as {
        patternLearner: {
          ['patterns']: { save(p: LearningPattern): Promise<void> };
        };
      }
    ).patternLearner['patterns'];
    await repo.save(planted);

    const out = await composed.feedback.record(analysis.id, true, 'helpful');
    expect(out.patternsTouched).toBeGreaterThanOrEqual(1);
  });
});
