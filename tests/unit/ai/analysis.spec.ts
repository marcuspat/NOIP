// Analysis aggregate invariants (DDD-08).

import { Analysis } from '../../../src/contexts/ai/domain/analysis';
import { FixedClock, newId, type ClusterId } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('Analysis aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
  const cluster = newId<ClusterId>();

  function start(): Analysis {
    return Analysis.start(
      {
        type: 'comprehensive',
        scope: { clusterId: cluster },
        strategy: {
          modelId: 'claude-3-5-haiku-20241022',
          promptTemplateHash: 'sha256:abc',
          retrievalPolicy: { topK: 5 },
        },
        requestedBy: { type: 'system' },
      },
      clock
    );
  }

  it('emits ai.analysis.requested on start', () => {
    const a = start();
    const events = a.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('ai.analysis.requested');
  });

  it('records strategy + retrieved ids on completion', () => {
    const a = start();
    a.drainEvents();
    a.complete(
      {
        retrieved: [
          {
            id: 'sha256:ctx-1' as never,
            score: 0.9,
            type: 'incident',
          },
        ],
        insights: [
          {
            text: 'i1',
            supportingContextIds: ['sha256:ctx-1' as never],
            severity: 'medium',
          },
        ],
        recommendations: [{ text: 'r1', action: 'review', references: [] }],
        predictions: [],
        confidence: 0.8,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        costEstimate: { amount: 0.001, currency: 'USD' },
        redaction: {
          secretsRedacted: 0,
          piiPseudonymised: 1,
          idsOpaqued: 0,
          bytesScrubbed: 16,
        },
      },
      clock
    );
    expect(a.status).toBe('succeeded');
    expect(a.retrieved.map(r => r.id)).toEqual(['sha256:ctx-1']);
    expect(a.strategy.modelId).toBe('claude-3-5-haiku-20241022');
    const events = a.drainEvents();
    expect(events.map(e => e.type)).toEqual(['ai.analysis.completed']);
  });

  it('rejects confidence outside [0, 1]', () => {
    const a = start();
    expect(() =>
      a.complete(
        {
          retrieved: [],
          insights: [],
          recommendations: [],
          predictions: [],
          confidence: 1.1,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          costEstimate: { amount: 0, currency: 'USD' },
          redaction: {
            secretsRedacted: 0,
            piiPseudonymised: 0,
            idsOpaqued: 0,
            bytesScrubbed: 0,
          },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('rejects zero-token completions', () => {
    const a = start();
    expect(() =>
      a.complete(
        {
          retrieved: [],
          insights: [],
          recommendations: [],
          predictions: [],
          confidence: 0.5,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          costEstimate: { amount: 0, currency: 'USD' },
          redaction: {
            secretsRedacted: 0,
            piiPseudonymised: 0,
            idsOpaqued: 0,
            bytesScrubbed: 0,
          },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('emits ai.analysis.failed on failure', () => {
    const a = start();
    a.drainEvents();
    a.fail({ code: 'PROVIDER_ERROR', message: 'boom' }, clock);
    expect(a.status).toBe('failed');
    const events = a.drainEvents();
    expect(events[0]?.type).toBe('ai.analysis.failed');
  });

  it('rejects double-completion', () => {
    const a = start();
    a.complete(
      {
        retrieved: [],
        insights: [],
        recommendations: [],
        predictions: [],
        confidence: 0.5,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costEstimate: { amount: 0, currency: 'USD' },
        redaction: {
          secretsRedacted: 0,
          piiPseudonymised: 0,
          idsOpaqued: 0,
          bytesScrubbed: 0,
        },
      },
      clock
    );
    expect(() =>
      a.complete(
        {
          retrieved: [],
          insights: [],
          recommendations: [],
          predictions: [],
          confidence: 0.5,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          costEstimate: { amount: 0, currency: 'USD' },
          redaction: {
            secretsRedacted: 0,
            piiPseudonymised: 0,
            idsOpaqued: 0,
            bytesScrubbed: 0,
          },
        },
        clock
      )
    ).toThrow(ValidationError);
  });

  it('round-trips via persistence', () => {
    const a = start();
    a.complete(
      {
        retrieved: [],
        insights: [{ text: 'x', supportingContextIds: [], severity: 'low' }],
        recommendations: [],
        predictions: [],
        confidence: 0.7,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costEstimate: { amount: 0.0001, currency: 'USD' },
        redaction: {
          secretsRedacted: 0,
          piiPseudonymised: 0,
          idsOpaqued: 0,
          bytesScrubbed: 0,
        },
      },
      clock
    );
    const persisted = a.toPersistence();
    const restored = Analysis.fromPersistence(persisted);
    expect(restored.id).toBe(a.id);
    expect(restored.confidence).toBe(0.7);
    expect(restored.insights[0]?.text).toBe('x');
  });
});
