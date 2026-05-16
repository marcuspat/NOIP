// AnthropicAdapter — anti-corruption layer for the Anthropic Claude API.
//
// Speaks `@anthropic-ai/sdk` on the wire and translates to the
// provider-neutral `LLMClient` port. Foreign types (Anthropic.Message,
// MessageCreateParams) NEVER leak above this module (DDD-16).
//
// Responsibilities:
//   1. Build messages from the LLMMessage[] (already redacted upstream).
//   2. Apply prompt-caching headers + cache_control on stable system content.
//   3. Wrap calls in retry (3 attempts, 200/400/800ms full jitter).
//   4. Wrap calls in a circuit breaker (5 fails / 30s; half-open after 60s).
//   5. Account tokens via the cost table; emit metrics-ready log lines.
//   6. Translate Anthropic.Message → domain Insight[]/Recommendation[]/Prediction[].
//   7. Surface errors as typed domain errors (BackpressureError /
//      RateLimitError / ProviderError / InternalError).
//
// Stub mode: if `apiKey` is empty (or `stubMode: true`), the adapter
// emits a deterministic synthetic response based on the prompt content
// — no setTimeout, no I/O. Unit tests run sub-millisecond.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { ProviderError, RateLimitError } from '../../../../shared/errors';
import type {
  LLMAnalyzeRequest,
  LLMAnalysisResult,
  LLMClient,
} from '../../domain/ports/llm-client';
import type {
  Insight,
  Prediction,
  Recommendation,
  Severity,
  TokenUsage,
} from '../../domain/value-objects';
import { Redactor } from '../../domain/redactor';
import {
  aiRequestTokensTotal,
  aiRequestsTotal,
} from '../../../../observability/metrics';
import { CircuitBreaker } from './circuit-breaker';
import { withRetry } from './retry';
import { DEFAULT_COST_TABLE, type ModelCost } from './cost-table';

export interface AnthropicAdapterLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /**
   * Optional. ADR-0023 moved per-request token tallies onto a real
   * Prometheus counter; the structured log line now lands on `debug`.
   * Older injected loggers without a `debug` method continue to work.
   */
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: AnthropicAdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface AnthropicAdapterOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  /** Override the cost table (per-model USD/Mtoken). */
  costTable?: Readonly<Record<string, ModelCost>>;
  /** Optional redactor for the *defensive* second-pass on raw text. */
  redactor?: Redactor;
  logger?: AnthropicAdapterLogger;
  clock: { nowInstant(): import('../../../../shared/kernel').Instant };
  /** Force stub mode regardless of apiKey. Default: stub when apiKey is empty. */
  stubMode?: boolean;
  /** Circuit-breaker overrides. */
  breaker?: ConstructorParameters<typeof CircuitBreaker>[0];
  /** Retry overrides. */
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  /**
   * Override the constructor for the upstream client. Tests inject a
   * mock that satisfies the surface we use (`messages.create`).
   */
  client?: AnthropicClientLike;
}

/**
 * Subset of the Anthropic SDK we depend on. Tests can satisfy this with
 * a hand-rolled stub instead of mocking the whole SDK.
 */
export interface AnthropicClientLike {
  messages: {
    create(body: unknown, opts?: unknown): Promise<unknown>;
  };
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

export class AnthropicAdapter implements LLMClient {
  private readonly client: AnthropicClientLike | null;
  private readonly defaultModel: string;
  private readonly logger: AnthropicAdapterLogger;
  private readonly breaker: CircuitBreaker;
  private readonly stubMode: boolean;
  private readonly retryOpts: NonNullable<AnthropicAdapterOptions['retry']>;
  // Kept for future cost-table overrides + redactor pre-checks; keep
  // references so a future spec change can lean on them.
  readonly costTable: Readonly<Record<string, ModelCost>>;
  readonly redactor: Redactor;

  constructor(opts: AnthropicAdapterOptions) {
    const apiKey = opts.apiKey ?? '';
    this.stubMode = opts.stubMode ?? apiKey.length === 0;
    if (this.stubMode) {
      this.client = null;
    } else if (opts.client) {
      this.client = opts.client;
    } else {
      this.client = new Anthropic({
        apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      }) as unknown as AnthropicClientLike;
    }
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.costTable = opts.costTable ?? DEFAULT_COST_TABLE;
    this.logger = opts.logger ?? NOOP_LOGGER;
    void opts.clock; // reserved for future timestamping
    this.redactor = opts.redactor ?? new Redactor();
    this.breaker = new CircuitBreaker(opts.breaker ?? {});
    this.retryOpts = opts.retry ?? { attempts: 3, baseMs: 200, capMs: 5000 };
  }

  async analyze(req: LLMAnalyzeRequest): Promise<LLMAnalysisResult> {
    if (this.stubMode) {
      return this.stubResponse(req);
    }

    const model = req.model ?? this.defaultModel;
    const body = this.buildRequestBody(req, model);

    const send = async (): Promise<AnthropicMessageResponse> => {
      try {
        const result = await this.client!.messages.create(body, {
          headers: {
            'anthropic-beta': 'prompt-caching-2024-07-31',
          },
        });
        return result as AnthropicMessageResponse;
      } catch (err) {
        throw this.translateProviderError(err);
      }
    };

    const respond = async (): Promise<AnthropicMessageResponse> => {
      return withRetry(send, {
        ...this.retryOpts,
        retriable: e => e instanceof RateLimitError || isTransient(e),
      });
    };

    try {
      const message = await this.breaker.execute(respond);
      const out = this.translateResponse(message, req, model);
      this.recordTokenMetrics(out);
      return out;
    } catch (err) {
      // Record the failure on the request counter; the breaker / retry
      // already logged details. Re-throw so the caller still sees the
      // typed domain error.
      aiRequestsTotal.labels({ type: 'analyze', result: 'error' }).inc();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildRequestBody(
    req: LLMAnalyzeRequest,
    model: string
  ): Record<string, unknown> {
    const system = req.messages
      .filter(m => m.role === 'system')
      .map(m =>
        m.cacheable
          ? {
              type: 'text',
              text: m.content,
              cache_control: { type: 'ephemeral' },
            }
          : { type: 'text', text: m.content }
      );

    const messages = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 2048,
      messages,
    };
    if (system.length > 0) {
      body['system'] = system;
    }
    return body;
  }

  private translateProviderError(err: unknown): Error {
    const status = readStatus(err);
    if (status === 429) {
      return new RateLimitError(60, 'Anthropic rate limit', undefined);
    }
    if (status !== undefined && status >= 500) {
      return new ProviderError('Anthropic upstream failure', { status });
    }
    if (status !== undefined && status >= 400) {
      return new ProviderError('Anthropic semantic error', { status });
    }
    if (err instanceof Error) {
      return new ProviderError(err.message);
    }
    return new ProviderError('Unknown Anthropic error');
  }

  private translateResponse(
    msg: AnthropicMessageResponse,
    _req: LLMAnalyzeRequest,
    model: string
  ): LLMAnalysisResult {
    const text = (msg.content ?? [])
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n');

    const tokens: TokenUsage = {
      input: Math.max(0, msg.usage?.input_tokens ?? 0),
      output: Math.max(0, msg.usage?.output_tokens ?? 0),
      cacheRead: Math.max(0, msg.usage?.cache_read_input_tokens ?? 0),
      cacheWrite: Math.max(0, msg.usage?.cache_creation_input_tokens ?? 0),
    };

    const parsed = parseStructured(text);
    return {
      insights: parsed.insights,
      recommendations: parsed.recommendations,
      predictions: parsed.predictions,
      rawText: text,
      confidence: parsed.confidence,
      tokens,
      modelId: msg.model ?? model,
    };
  }

  private stubResponse(req: LLMAnalyzeRequest): LLMAnalysisResult {
    // Deterministic synthetic response for tests / no-API-key envs.
    const userText = req.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n');
    const fingerprint = createHash('sha256')
      .update(userText)
      .digest('hex')
      .slice(0, 8);

    const insights: Insight[] = [
      {
        text: `[stub:${req.templateName}] grounded analysis fingerprint=${fingerprint}`,
        supportingContextIds: [],
        severity: 'medium',
      },
    ];
    const recommendations: Recommendation[] = [
      {
        text: 'Review the analysis output and refine the prompt template if needed.',
        action: 'review',
        references: [],
      },
    ];
    const predictions: Prediction[] = [
      {
        text: 'Stub mode is in effect; configure AI_API_KEY to enable live analysis.',
        horizon: 'P0D',
        probability: 1.0,
      },
    ];
    const inputTokens = Math.max(1, Math.floor(userText.length / 4));
    const tokens: TokenUsage = {
      input: inputTokens,
      output: 64,
      cacheRead: 0,
      cacheWrite: 0,
    };
    return {
      insights,
      recommendations,
      predictions,
      rawText: JSON.stringify({ insights, recommendations, predictions }),
      confidence: 0.5,
      tokens,
      modelId: req.model ?? this.defaultModel,
    };
  }

  private recordTokenMetrics(result: LLMAnalysisResult): void {
    // ADR-0023: real Prometheus counters. Each call is O(1) — the
    // structured log line below stays as a debug fallback so local
    // dev still has a grep-able paper trail.
    aiRequestsTotal.labels({ type: 'analyze', result: 'success' }).inc();

    aiRequestTokensTotal
      .labels({ type: 'input', direction: 'request' })
      .inc(result.tokens.input);
    aiRequestTokensTotal
      .labels({ type: 'output', direction: 'response' })
      .inc(result.tokens.output);
    if (result.tokens.cacheRead > 0) {
      aiRequestTokensTotal
        .labels({ type: 'cache_read', direction: 'request' })
        .inc(result.tokens.cacheRead);
    }
    if (result.tokens.cacheWrite > 0) {
      aiRequestTokensTotal
        .labels({ type: 'cache_write', direction: 'request' })
        .inc(result.tokens.cacheWrite);
    }
    this.logger.debug?.('noip_ai_request_tokens_total', {
      model: result.modelId,
      input: result.tokens.input,
      output: result.tokens.output,
      cacheRead: result.tokens.cacheRead,
      cacheWrite: result.tokens.cacheWrite,
    });
  }
}

interface ParsedLLMOutput {
  insights: Insight[];
  recommendations: Recommendation[];
  predictions: Prediction[];
  confidence: number;
}

function parseStructured(text: string): ParsedLLMOutput {
  // Attempt to locate a JSON object inside the response. Tolerant to
  // surrounding chatter the model may have emitted.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      insights: [],
      recommendations: [],
      predictions: [],
      confidence: 0.5,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {
      insights: [],
      recommendations: [],
      predictions: [],
      confidence: 0.5,
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      insights: [],
      recommendations: [],
      predictions: [],
      confidence: 0.5,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const insights = Array.isArray(obj['insights'])
    ? (obj['insights'] as unknown[]).map(toInsight).filter(notNull)
    : [];
  const recommendations = Array.isArray(obj['recommendations'])
    ? (obj['recommendations'] as unknown[])
        .map(toRecommendation)
        .filter(notNull)
    : [];
  const predictions = Array.isArray(obj['predictions'])
    ? (obj['predictions'] as unknown[]).map(toPrediction).filter(notNull)
    : [];
  const c =
    typeof obj['confidence'] === 'number' &&
    obj['confidence'] >= 0 &&
    obj['confidence'] <= 1
      ? obj['confidence']
      : 0.5;
  return {
    insights,
    recommendations,
    predictions,
    confidence: c,
  };
}

function toInsight(raw: unknown): Insight | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r['text'] === 'string' ? r['text'] : null;
  if (text === null) return null;
  const supporting = Array.isArray(r['supportingContextIds'])
    ? (r['supportingContextIds'] as unknown[]).filter(
        v => typeof v === 'string'
      )
    : [];
  const sev: Severity =
    r['severity'] === 'low' ||
    r['severity'] === 'medium' ||
    r['severity'] === 'high' ||
    r['severity'] === 'critical'
      ? r['severity']
      : 'medium';
  return {
    text,
    supportingContextIds: supporting as Insight['supportingContextIds'],
    severity: sev,
  };
}

function toRecommendation(raw: unknown): Recommendation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r['text'] === 'string' ? r['text'] : null;
  if (text === null) return null;
  const action = typeof r['action'] === 'string' ? r['action'] : 'review';
  const references = Array.isArray(r['references'])
    ? (r['references'] as unknown[]).filter(v => typeof v === 'string')
    : [];
  return { text, action, references: references as string[] };
}

function toPrediction(raw: unknown): Prediction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r['text'] === 'string' ? r['text'] : null;
  if (text === null) return null;
  const horizon = typeof r['horizon'] === 'string' ? r['horizon'] : 'P30D';
  const prob =
    typeof r['probability'] === 'number' &&
    r['probability'] >= 0 &&
    r['probability'] <= 1
      ? r['probability']
      : 0.5;
  return { text, horizon, probability: prob };
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

function readStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const r = err as Record<string, unknown>;
    if (typeof r['status'] === 'number') return r['status'];
    if (typeof r['statusCode'] === 'number') return r['statusCode'];
  }
  return undefined;
}

function isTransient(err: unknown): boolean {
  const s = readStatus(err);
  if (s === undefined) {
    if (err instanceof ProviderError) return true;
    return false;
  }
  return s === 429 || s >= 500;
}
