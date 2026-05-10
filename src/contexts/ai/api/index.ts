// Public API barrel for the AI Analysis context (DDD-08).
// Per ADR-0011 cross-context callers MUST only import from this module.
//
// What we expose:
//   - The `AIPublicApi` interface.
//   - Aggregates and value objects (as `import type`) needed by
//     downstream contexts (Dashboard, Notifications).
//   - The `composeAI` factory that wires everything for the composition
//     root and tests.
//   - The HTTP router factory.
//
// Anything not re-exported here is private to the context.

import type { Router } from 'express';
import type { Clock, EventBus, Unsubscribe } from '../../../shared/kernel';
import { AIService } from '../application/ai.service';
import type { AIServiceLogger } from '../application/ai.service';
import { AnalysisOrchestrator } from '../application/analysis-orchestrator';
import { FeedbackService } from '../application/feedback.service';
import { PatternLearner } from '../application/pattern-learner';
import { Redactor } from '../domain/redactor';
import { PromptComposer } from '../domain/prompt-composer';
import { ContextRetriever } from '../domain/context-retriever';
import { CostMeter } from '../domain/cost-meter';
import {
  MongooseAnalysisRepository,
  type AnalysisRepository,
} from '../infrastructure/persistence/analysis.repository';
import {
  MongooseLearningPatternRepository,
  type LearningPatternRepository,
} from '../infrastructure/persistence/learning-pattern.repository';
import {
  MongooseAIContextProjectionRepository,
  type AIContextProjectionRepository,
} from '../infrastructure/persistence/ai-context-projection.repository';
import { AnthropicAdapter } from '../infrastructure/anthropic/anthropic-adapter';
import { InMemoryRagStore } from '../infrastructure/chroma/in-memory-rag-store';
import { NoOpIngestionBridge } from '../infrastructure/python/no-op-bridge';
import type { LLMClient } from '../domain/ports/llm-client';
import type { RagStore } from '../domain/ports/rag-store';
import type { IngestionBridge } from '../domain/ports/ingestion-bridge';
import type { CostMeterRedis, CostMeterOptions } from '../domain/cost-meter';
import type { AnalysisOrchestratorRedis } from '../application/analysis-orchestrator';
import aiRoutesFactory from '../http/routes';
import type { Insight, Scope } from '../domain/value-objects';
import type { AnalysisType } from '../domain/value-objects';

// ---------------------------------------------------------------------------
// Re-exports (public domain types)
// ---------------------------------------------------------------------------
export { Analysis } from '../domain/analysis';
export type {
  AnalysisError,
  AnalysisStatus,
  AnalysisStartSpec,
  AnalysisCompleteSpec,
} from '../domain/analysis';
export { LearningPattern } from '../domain/learning-pattern';
export { AIContext, contextIdFor } from '../domain/ai-context';
export type {
  AIContextRef,
  AIContextType,
  AnalysisType,
  ActorRef,
  Embedding,
  Insight,
  Money,
  Prediction,
  PromptTemplateName,
  Recommendation,
  RedactionReport,
  RetrievalPolicy,
  Scope,
  Severity,
  Strategy,
  TokenUsage,
} from '../domain/value-objects';
export { Redactor } from '../domain/redactor';
export { PromptComposer, DEFAULT_TEMPLATES } from '../domain/prompt-composer';
export { ContextRetriever } from '../domain/context-retriever';
export { CostMeter } from '../domain/cost-meter';
export { AIService } from '../application/ai.service';
export type { AnalysisInput } from '../application/ai.service';
export { AnalysisOrchestrator } from '../application/analysis-orchestrator';
export { FeedbackService } from '../application/feedback.service';
export { PatternLearner } from '../application/pattern-learner';
export type {
  LLMClient,
  LLMAnalyzeRequest,
  LLMAnalysisResult,
  LLMMessage,
} from '../domain/ports/llm-client';
export type {
  RagStore,
  RagDocumentInput,
  RagHit,
  RagIngestSummary,
  RagQueryOptions,
} from '../domain/ports/rag-store';
export type {
  IngestionBridge,
  IngestionRunSummary,
  IngestionTriggerSpec,
} from '../domain/ports/ingestion-bridge';
export { AnthropicAdapter } from '../infrastructure/anthropic/anthropic-adapter';
export type {
  AnthropicAdapterOptions,
  AnthropicClientLike,
} from '../infrastructure/anthropic/anthropic-adapter';
export { CircuitBreaker } from '../infrastructure/anthropic/circuit-breaker';
export { withRetry } from '../infrastructure/anthropic/retry';
export {
  DEFAULT_COST_TABLE,
  estimateCost,
  type ModelCost,
} from '../infrastructure/anthropic/cost-table';
export { InMemoryRagStore } from '../infrastructure/chroma/in-memory-rag-store';
export { ChromaAdapter } from '../infrastructure/chroma/chroma-adapter';
export { PythonRagBridge } from '../infrastructure/python/python-rag-bridge';
export { NoOpIngestionBridge } from '../infrastructure/python/no-op-bridge';
export {
  InMemoryAnalysisRepository,
  MongooseAnalysisRepository,
  type AnalysisRepository,
} from '../infrastructure/persistence/analysis.repository';
export {
  InMemoryLearningPatternRepository,
  MongooseLearningPatternRepository,
  type LearningPatternRepository,
} from '../infrastructure/persistence/learning-pattern.repository';
export {
  InMemoryAIContextProjectionRepository,
  MongooseAIContextProjectionRepository,
  type AIContextProjectionRepository,
} from '../infrastructure/persistence/ai-context-projection.repository';

// ---------------------------------------------------------------------------
// Public API contract per DDD-08
// ---------------------------------------------------------------------------

export interface AIPublicApi {
  runAnalysis(
    req: import('../../../types').AIAnalysisRequest
  ): Promise<import('../../../types').AIAnalysisResult>;
  getLatestInsights(scope: Scope, type?: AnalysisType): Promise<Insight[]>;
  /** Subscribe to `ai.*` events. Returns an unsubscribe handle. */
  streamEvents(
    handler: (eventType: string, payload: unknown) => void
  ): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposeAIDeps {
  bus: EventBus;
  clock: Clock;
  logger?: AIServiceLogger;
  /** Optional LLM client; defaults to AnthropicAdapter in stub mode. */
  llmClient?: LLMClient;
  /** Optional RagStore; defaults to InMemoryRagStore. */
  ragStore?: RagStore;
  /** Optional ingestion bridge; defaults to NoOpIngestionBridge. */
  ingestion?: IngestionBridge;
  /** Optional Redis client for cost tracking + idempotency locks. */
  redis?: CostMeterRedis & AnalysisOrchestratorRedis;
  /** Optional repository overrides (tests). */
  repos?: {
    analyses?: AnalysisRepository;
    patterns?: LearningPatternRepository;
    contexts?: AIContextProjectionRepository;
  };
  /** Optional default model id. */
  defaultModel?: string;
  /** Optional CostMeter overrides (daily budget, TTL). */
  costMeter?: Partial<Pick<CostMeterOptions, 'dailyBudgetUsd' | 'ttlSec'>>;
  /** Discovery / Security / Compliance public APIs (read-only). */
  discovery?: unknown;
  security?: unknown;
  compliance?: unknown;
}

export interface ComposedAI {
  service: AIService;
  orchestrator: AnalysisOrchestrator;
  feedback: FeedbackService;
  patternLearner: PatternLearner;
  publicApi: AIPublicApi;
  router: Router;
  subscriptions: Unsubscribe[];
  rag: RagStore;
  llm: LLMClient;
}

/**
 * Wire the AI context. The composition root passes a `redis` client so
 * the CostMeter and AnalysisOrchestrator can lock and track spend.
 * Tests omit it — the orchestrator falls back to an in-memory lock map
 * and the CostMeter accepts a simple in-memory pipeline.
 */
export function composeAI(deps: ComposeAIDeps): ComposedAI {
  const llm = deps.llmClient ?? new AnthropicAdapter({ clock: deps.clock });
  const rag = deps.ragStore ?? new InMemoryRagStore();
  const ingestion = deps.ingestion ?? new NoOpIngestionBridge();
  const analyses = deps.repos?.analyses ?? new MongooseAnalysisRepository();
  const patterns =
    deps.repos?.patterns ?? new MongooseLearningPatternRepository();
  const contexts =
    deps.repos?.contexts ?? new MongooseAIContextProjectionRepository();

  const composer = new PromptComposer();
  const retriever = new ContextRetriever(rag);
  const redactor = new Redactor();

  const costMeter = new CostMeter({
    redis: deps.redis ?? createInMemoryCostRedis(),
    bus: deps.bus,
    clock: deps.clock,
    ...(deps.costMeter?.dailyBudgetUsd !== undefined
      ? { dailyBudgetUsd: deps.costMeter.dailyBudgetUsd }
      : {}),
    ...(deps.costMeter?.ttlSec !== undefined
      ? { ttlSec: deps.costMeter.ttlSec }
      : {}),
  });

  const patternLearner = new PatternLearner({
    patterns,
    bus: deps.bus,
    clock: deps.clock,
  });

  const service = new AIService({
    llm,
    rag,
    ingestion,
    analyses,
    contexts,
    patternLearner,
    redactor,
    composer,
    retriever,
    costMeter,
    bus: deps.bus,
    clock: deps.clock,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.defaultModel !== undefined
      ? { defaultModel: deps.defaultModel }
      : {}),
  });

  const feedback = new FeedbackService({
    analyses,
    patterns,
    learner: patternLearner,
  });

  const orchestrator = new AnalysisOrchestrator({
    bus: deps.bus,
    ai: service,
    redis: deps.redis ?? null,
  });
  const subscriptions = orchestrator.install();

  const publicApi: AIPublicApi = {
    runAnalysis: req => service.runAnalysis(req),
    getLatestInsights: (scope, type) => service.getInsights(scope, type),
    streamEvents: handler => {
      const h = deps.bus.subscribe('ai.*', evt =>
        handler(evt.type, evt.payload)
      );
      return h;
    },
  };

  return {
    service,
    orchestrator,
    feedback,
    patternLearner,
    publicApi,
    router: aiRoutesFactory({ service, feedback }),
    subscriptions,
    rag,
    llm,
  };
}

/** A minimal in-memory CostMeterRedis used when no real Redis client is provided. */
export function createInMemoryCostRedis(): CostMeterRedis {
  const store = new Map<string, { value: number; expiresAt: number }>();
  function purge(): void {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt <= now) store.delete(k);
    }
  }
  return {
    pipeline() {
      const ops: Array<{
        type: 'incr' | 'expire' | 'get';
        key: string;
        amount?: number;
        seconds?: number;
      }> = [];
      const api = {
        incrbyfloat(key: string, amount: number) {
          ops.push({ type: 'incr', key, amount });
          return api;
        },
        expire(key: string, seconds: number) {
          ops.push({ type: 'expire', key, seconds });
          return api;
        },
        get(key: string) {
          ops.push({ type: 'get', key });
          return api;
        },
        async exec() {
          purge();
          const results: Array<[Error | null, unknown]> = [];
          for (const op of ops) {
            if (op.type === 'incr') {
              const cur = store.get(op.key);
              const next = (cur?.value ?? 0) + (op.amount ?? 0);
              store.set(op.key, {
                value: next,
                expiresAt: cur?.expiresAt ?? Number.MAX_SAFE_INTEGER,
              });
              results.push([null, next.toString()]);
            } else if (op.type === 'expire') {
              const cur = store.get(op.key);
              if (cur) {
                cur.expiresAt = Date.now() + (op.seconds ?? 0) * 1000;
                results.push([null, 1]);
              } else {
                results.push([null, 0]);
              }
            } else {
              const cur = store.get(op.key);
              results.push([null, cur ? cur.value.toString() : null]);
            }
          }
          return results;
        },
      };
      return api;
    },
    async get(key: string): Promise<string | null> {
      purge();
      const cur = store.get(key);
      return cur ? cur.value.toString() : null;
    },
  };
}
