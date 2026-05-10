// AIService — full analyze flow with stubs.

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

function makeHarness(): {
  composed: ReturnType<typeof composeAI>;
  events: DomainEvent<unknown>[];
} {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const bus = new InMemoryEventBus({
    warn: () => undefined,
    error: () => undefined,
  });
  const events: DomainEvent<unknown>[] = [];
  bus.subscribe('ai.*', e => events.push(e as DomainEvent<unknown>));
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
  return { composed, events };
}

describe('AIService.analyze', () => {
  it('emits ai.analysis.requested then ai.analysis.completed in order', async () => {
    const { composed, events } = makeHarness();
    const cluster = newId<ClusterId>();
    await composed.service.analyzeSecurity({
      scope: { clusterId: cluster },
      payload: { findings: [{ kind: 'Pod', severity: 'high' }] },
    });
    const types = events.map(e => e.type);
    const reqIdx = types.indexOf('ai.analysis.requested');
    const compIdx = types.indexOf('ai.analysis.completed');
    expect(reqIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeGreaterThan(reqIdx);
  });

  it('records strategy + retrieved on the analysis aggregate', async () => {
    const { composed } = makeHarness();
    await composed.rag.ingest([
      {
        content: 'historical: privileged container risk',
        metadata: { type: 'incident' },
      },
    ]);
    const cluster = newId<ClusterId>();
    const analysis = await composed.service.analyzeSecurity({
      scope: { clusterId: cluster },
      payload: { issue: 'privileged container detected' },
    });
    expect(analysis.strategy.modelId).toBeTruthy();
    expect(analysis.strategy.promptTemplateHash.startsWith('sha256:')).toBe(
      true
    );
    expect(analysis.confidence).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence).toBeLessThanOrEqual(1);
    expect(analysis.tokens.input + analysis.tokens.output).toBeGreaterThan(0);
  });

  it('legacy runAnalysis returns the AIAnalysisResult shape', async () => {
    const { composed } = makeHarness();
    const out = await composed.service.runAnalysis({
      type: 'security',
      data: { clusterId: 'cluster-1', issue: 'x' },
    });
    expect(Array.isArray(out.insights)).toBe(true);
    expect(typeof out.confidence).toBe('number');
    expect(out.timestamp).toBeInstanceOf(Date);
  });

  it('ingestContext deduplicates across calls', async () => {
    const { composed } = makeHarness();
    const r1 = await composed.service.ingestContext([
      { type: 'incident', content: 'same content', source: 'audit' },
    ]);
    const r2 = await composed.service.ingestContext([
      { type: 'incident', content: 'same content', source: 'audit' },
    ]);
    expect(r1.ingested).toBe(1);
    expect(r2.deduped).toBe(1);
  });
});
