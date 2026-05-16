// AnthropicAdapter — stub mode determinism, retry on 429/5xx, circuit
// breaker, token accounting.

import {
  AnthropicAdapter,
  type AnthropicClientLike,
} from '../../../src/contexts/ai/infrastructure/anthropic/anthropic-adapter';
import { CircuitBreaker } from '../../../src/contexts/ai/infrastructure/anthropic/circuit-breaker';
import {
  BackpressureError,
  ProviderError,
  RateLimitError,
} from '../../../src/shared/errors';
import { FixedClock } from '../../../src/shared/kernel';
import type { LLMMessage } from '../../../src/contexts/ai/domain/ports/llm-client';
import {
  aiRequestTokensTotal,
  aiRequestsTotal,
} from '../../../src/observability/metrics';

const SAMPLE_MESSAGES: LLMMessage[] = [
  { role: 'system', content: 'You are NOIP.', cacheable: true },
  { role: 'user', content: 'analyze cluster X' },
];

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

describe('AnthropicAdapter (stub mode)', () => {
  it('produces a deterministic response when no API key is configured', async () => {
    const adapter = new AnthropicAdapter({ clock });
    const a = await adapter.analyze({
      analysisType: 'comprehensive',
      templateName: 'comprehensive',
      messages: SAMPLE_MESSAGES,
    });
    const b = await adapter.analyze({
      analysisType: 'comprehensive',
      templateName: 'comprehensive',
      messages: SAMPLE_MESSAGES,
    });
    expect(a.insights[0]?.text).toBe(b.insights[0]?.text);
    expect(a.tokens.input + a.tokens.output).toBeGreaterThan(0);
  });

  it('returns a populated TokenUsage for cost accounting', async () => {
    const adapter = new AnthropicAdapter({ clock });
    const r = await adapter.analyze({
      analysisType: 'security',
      templateName: 'security_focused',
      messages: SAMPLE_MESSAGES,
    });
    expect(r.tokens.input).toBeGreaterThan(0);
    expect(r.tokens.output).toBeGreaterThan(0);
  });
});

describe('AnthropicAdapter (live mode with mock client)', () => {
  function mockClient(impl: () => Promise<unknown>): AnthropicClientLike {
    return { messages: { create: impl } };
  }

  it('translates a successful Anthropic.Message into domain types', async () => {
    const sample = {
      id: 'msg_x',
      model: 'claude-3-5-haiku-20241022',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            insights: [
              {
                text: 'risk found',
                supportingContextIds: ['sha256:c1'],
                severity: 'high',
              },
            ],
            recommendations: [
              { text: 'apply policy', action: 'apply', references: [] },
            ],
            predictions: [
              { text: 'will recur', horizon: 'P30D', probability: 0.7 },
            ],
            confidence: 0.85,
          }),
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5,
      },
    };
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      clock,
      stubMode: false,
      client: mockClient(async () => sample),
      retry: { attempts: 1, baseMs: 1, capMs: 1 },
    });
    const r = await adapter.analyze({
      analysisType: 'security',
      templateName: 'security_focused',
      messages: SAMPLE_MESSAGES,
    });
    expect(r.insights[0]?.text).toBe('risk found');
    expect(r.recommendations[0]?.action).toBe('apply');
    expect(r.predictions[0]?.probability).toBeCloseTo(0.7);
    expect(r.tokens.cacheRead).toBe(5);
    expect(r.confidence).toBeCloseTo(0.85);
  });

  it('retries on 5xx then succeeds', async () => {
    let n = 0;
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      clock,
      stubMode: false,
      client: mockClient(async () => {
        n++;
        if (n < 2) {
          const err: Error & { status?: number } = new Error('500');
          err.status = 500;
          throw err;
        }
        return {
          model: 'claude-3-5-haiku-20241022',
          content: [
            {
              type: 'text',
              text: '{"insights":[],"recommendations":[],"predictions":[],"confidence":0.5}',
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
      retry: { attempts: 3, baseMs: 1, capMs: 1 },
    });
    const r = await adapter.analyze({
      analysisType: 'comprehensive',
      templateName: 'comprehensive',
      messages: SAMPLE_MESSAGES,
    });
    expect(n).toBe(2);
    expect(r.confidence).toBeCloseTo(0.5);
  });

  it('translates 429 into RateLimitError', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      clock,
      stubMode: false,
      client: mockClient(async () => {
        const err: Error & { status?: number } = new Error('429');
        err.status = 429;
        throw err;
      }),
      retry: { attempts: 1, baseMs: 1, capMs: 1 },
    });
    await expect(
      adapter.analyze({
        analysisType: 'security',
        templateName: 'security_focused',
        messages: SAMPLE_MESSAGES,
      })
    ).rejects.toThrow(RateLimitError);
  });

  it('fires the ADR-0023 token + request counters on a successful call', async () => {
    const beforeReq = labelValue(aiRequestsTotal, {
      type: 'analyze',
      result: 'success',
    });
    const beforeInput = labelValue(aiRequestTokensTotal, {
      type: 'input',
      direction: 'request',
    });

    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      clock,
      stubMode: false,
      client: mockClient(async () => ({
        model: 'claude-3-5-haiku-20241022',
        content: [
          {
            type: 'text',
            text: '{"insights":[],"recommendations":[],"predictions":[],"confidence":0.5}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 9 },
      })),
      retry: { attempts: 1, baseMs: 1, capMs: 1 },
    });
    await adapter.analyze({
      analysisType: 'comprehensive',
      templateName: 'comprehensive',
      messages: SAMPLE_MESSAGES,
    });

    expect(
      labelValue(aiRequestsTotal, { type: 'analyze', result: 'success' }) -
        beforeReq
    ).toBe(1);
    expect(
      labelValue(aiRequestTokensTotal, {
        type: 'input',
        direction: 'request',
      }) - beforeInput
    ).toBe(12);
  });
});

function labelValue(
  metric: unknown,
  labels: Record<string, string>
): number {
  const hashMap = (
    metric as {
      hashMap: Record<
        string,
        { labels: Record<string, string>; value: number }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(hashMap)) {
    let match = true;
    for (const [k, v] of Object.entries(labels)) {
      if (entry.labels[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) return entry.value;
  }
  return 0;
}

describe('CircuitBreaker', () => {
  it('opens after 5 failures within 30s and rejects with BackpressureError', async () => {
    let now = 1000;
    const breaker = new CircuitBreaker({
      windowMs: 30_000,
      failureThreshold: 5,
      openMs: 60_000,
      now: () => now,
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new ProviderError('upstream');
        })
      ).rejects.toThrow(ProviderError);
      now += 100;
    }
    await expect(breaker.execute(async () => 'never')).rejects.toBeInstanceOf(
      BackpressureError
    );
  });

  it('moves to half-open after 60s and closes on success', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      windowMs: 30_000,
      failureThreshold: 2,
      openMs: 60_000,
      now: () => now,
    });
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          throw new ProviderError('boom');
        })
      ).rejects.toThrow();
      now += 100;
    }
    expect(breaker.getState()).toBe('open');
    now += 60_001;
    expect(breaker.getState()).toBe('half-open');
    const out = await breaker.execute(async () => 'ok');
    expect(out).toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });
});
