// AIService — application service for the AI Analysis context (DDD-08).
//
// Drives the canonical analyse use-case:
//   1. Open an `Analysis` aggregate with its Strategy.
//   2. Retrieve top-k RAG context.
//   3. Apply the Redactor to the scope payload.
//   4. Compose the prompt via PromptComposer.
//   5. Invoke the LLM client.
//   6. Charge the CostMeter.
//   7. Hand the insights to the PatternLearner.
//   8. Persist + publish events.

import type {
  AnalysisId,
  Clock,
  ContextId,
  EventBus,
  UserId,
} from '../../../shared/kernel';
import { NotFoundError, ValidationError } from '../../../shared/errors';
import { Analysis } from '../domain/analysis';
import type {
  ActorRef,
  AIContextRef,
  AIContextType,
  AnalysisType,
  Insight,
  Money,
  PromptTemplateName,
  RetrievalPolicy,
  Scope,
  Strategy,
  TokenUsage,
} from '../domain/value-objects';
import type { AIAnalysisRequest, AIAnalysisResult } from '../../../types';
import { Redactor } from '../domain/redactor';
import { PromptComposer } from '../domain/prompt-composer';
import { ContextRetriever } from '../domain/context-retriever';
import { CostMeter } from '../domain/cost-meter';
import { AIContext } from '../domain/ai-context';
import type { LLMClient } from '../domain/ports/llm-client';
import type { RagStore } from '../domain/ports/rag-store';
import type { IngestionBridge } from '../domain/ports/ingestion-bridge';
import type { AnalysisRepository } from '../infrastructure/persistence/analysis.repository';
import type { AIContextProjectionRepository } from '../infrastructure/persistence/ai-context-projection.repository';
import { estimateCost } from '../infrastructure/anthropic/cost-table';
import { PatternLearner } from './pattern-learner';

export interface AIServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: AIServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface AnalysisInput {
  scope: Scope;
  payload: unknown;
  /** Override default template selection for this analysis type. */
  templateName?: PromptTemplateName;
  /** Override the retrieval policy. */
  retrievalPolicy?: Partial<RetrievalPolicy>;
  /** Default 'system' (orchestrator-driven). HTTP routes pass the user. */
  requestedBy?: ActorRef;
  /** Optional UserId to charge the CostMeter against. */
  userId?: UserId;
  /** Optional model override. */
  model?: string;
  /** Optional max tokens. */
  maxTokens?: number;
}

export interface AIServiceOptions {
  llm: LLMClient;
  rag: RagStore;
  ingestion: IngestionBridge;
  analyses: AnalysisRepository;
  contexts: AIContextProjectionRepository;
  patternLearner: PatternLearner;
  redactor: Redactor;
  composer: PromptComposer;
  retriever: ContextRetriever;
  costMeter: CostMeter;
  bus: EventBus;
  clock: Clock;
  logger?: AIServiceLogger;
  /** Default model id used when no override is provided. */
  defaultModel?: string;
}

export class AIService {
  private readonly llm: LLMClient;
  private readonly rag: RagStore;
  private readonly ingestion: IngestionBridge;
  private readonly analyses: AnalysisRepository;
  private readonly contexts: AIContextProjectionRepository;
  private readonly learner: PatternLearner;
  private readonly redactor: Redactor;
  private readonly composer: PromptComposer;
  private readonly retriever: ContextRetriever;
  private readonly costMeter: CostMeter;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: AIServiceLogger;
  private readonly defaultModel: string;

  constructor(opts: AIServiceOptions) {
    this.llm = opts.llm;
    this.rag = opts.rag;
    this.ingestion = opts.ingestion;
    this.analyses = opts.analyses;
    this.contexts = opts.contexts;
    this.learner = opts.patternLearner;
    this.redactor = opts.redactor;
    this.composer = opts.composer;
    this.retriever = opts.retriever;
    this.costMeter = opts.costMeter;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.defaultModel = opts.defaultModel ?? 'claude-3-5-haiku-20241022';
  }

  // ---------------------------------------------------------------------------
  // Type-specific entrypoints (used by HTTP routes + orchestrator)
  // ---------------------------------------------------------------------------
  async analyzeInfrastructure(input: AnalysisInput): Promise<Analysis> {
    return this.analyze('comprehensive', input);
  }
  async analyzeSecurity(input: AnalysisInput): Promise<Analysis> {
    return this.analyze('security', input);
  }
  async analyzeCompliance(input: AnalysisInput): Promise<Analysis> {
    return this.analyze('compliance', input);
  }
  async analyzePerformance(input: AnalysisInput): Promise<Analysis> {
    return this.analyze('performance', input);
  }
  async analyzeCost(input: AnalysisInput): Promise<Analysis> {
    return this.analyze('cost', input);
  }

  // ---------------------------------------------------------------------------
  // Generic entrypoints
  // ---------------------------------------------------------------------------
  async analyze(type: AnalysisType, input: AnalysisInput): Promise<Analysis> {
    if (!input.scope || !input.scope.clusterId) {
      throw new ValidationError('scope.clusterId is required');
    }
    const templateName =
      input.templateName ?? PromptComposer.templateForAnalysisType(type);
    const tpl = this.composer.getTemplate(templateName);
    const policy: RetrievalPolicy = {
      topK: input.retrievalPolicy?.topK ?? tpl.topK,
      ...((input.retrievalPolicy?.filter ?? tpl.filter)
        ? { filter: input.retrievalPolicy?.filter ?? tpl.filter }
        : {}),
      ...(input.retrievalPolicy?.collections
        ? { collections: input.retrievalPolicy.collections }
        : {}),
    };
    const requestedBy: ActorRef = input.requestedBy ?? { type: 'system' };

    // 1) Redact the payload (string form). The Redactor scrubs every
    //    string the prompt-composer renders into the user message.
    const renderedPayload = safeStringify(input.payload);
    const redaction = this.redactor.redact(renderedPayload);

    // 2) Top-k retrieval. The retrieved ids are recorded on the analysis.
    const retrieved = await this.retriever.retrieve({
      query: redaction.redacted,
      policy,
    });

    // 3) Compose the prompt.
    const composed = this.composer.compose({
      templateName,
      scopePayload: redaction.redacted,
      retrieved,
    });

    // 4) Strategy snapshot — recorded on the aggregate for reproducibility.
    const strategy: Strategy = {
      modelId: input.model ?? this.defaultModel,
      promptTemplateHash: composed.systemPromptHash,
      retrievalPolicy: policy,
    };

    // 5) Open the aggregate & publish ai.analysis.requested.
    const analysis = Analysis.start(
      { type, scope: input.scope, strategy, requestedBy },
      this.clock
    );
    this.bus.publishMany(analysis.drainEvents());
    analysis.markRunning();

    // 6) Invoke the LLM. On failure mark the aggregate failed and rethrow.
    try {
      const llmRequest: Parameters<LLMClient['analyze']>[0] = {
        analysisType: type,
        templateName,
        messages: composed.messages,
      };
      if (input.model !== undefined) llmRequest.model = input.model;
      if (input.maxTokens !== undefined) llmRequest.maxTokens = input.maxTokens;
      const llmResult = await this.llm.analyze(llmRequest);

      const tokens: TokenUsage = llmResult.tokens;
      const costAmount = estimateCost(llmResult.modelId, tokens);
      const costEstimate: Money = {
        amount: round4(costAmount),
        currency: 'USD',
      };

      // 7) Charge the cost meter (may throw RateLimitError).
      await this.costMeter.charge({
        userId: input.userId ?? null,
        amount: costEstimate,
      });

      // 8) Materialise the strategy modelId from the actual model used.
      const recorded = composed.retrieved;

      analysis.complete(
        {
          retrieved: recorded,
          insights: llmResult.insights,
          recommendations: llmResult.recommendations,
          predictions: llmResult.predictions,
          confidence: llmResult.confidence,
          tokens,
          costEstimate,
          redaction: redaction.report,
        },
        this.clock
      );

      await this.analyses.save(analysis);
      this.bus.publishMany(analysis.drainEvents());

      // 9) Pattern learning.
      await this.learner.observeInsights({
        type,
        insights: llmResult.insights,
      });

      return analysis;
    } catch (err) {
      analysis.fail(
        {
          code: classifyErr(err),
          message: err instanceof Error ? err.message : String(err),
        },
        this.clock
      );
      try {
        await this.analyses.save(analysis);
      } catch (saveErr) {
        this.logger.warn('failed to save failed analysis', {
          err: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
      }
      this.bus.publishMany(analysis.drainEvents());
      throw err;
    }
  }

  /**
   * Legacy DTO entrypoint preserved so the existing HTTP edge tests
   * continue to pass. Returns the legacy `AIAnalysisResult` shape.
   */
  async runAnalysis(req: AIAnalysisRequest): Promise<AIAnalysisResult> {
    const scope: Scope = readScopeFromLegacy(req.data);
    const type =
      req.type === 'security' ||
      req.type === 'performance' ||
      req.type === 'compliance' ||
      req.type === 'cost'
        ? req.type
        : ('comprehensive' as const);
    const input: AnalysisInput = { scope, payload: req.data };
    if (req.strategy !== undefined) {
      input.templateName = mapLegacyStrategy(req.strategy, type);
    }
    const analysis = await this.analyze(type, input);
    return projectToLegacy(analysis);
  }

  // ---------------------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------------------
  async getInsights(scope: Scope, type?: AnalysisType): Promise<Insight[]> {
    const analyses = await this.analyses.listLatestByScope(scope, type, 5);
    const out: Insight[] = [];
    for (const a of analyses) {
      for (const i of a.insights) out.push(i);
    }
    return out;
  }

  async getAnalysisById(id: AnalysisId): Promise<Analysis> {
    const a = await this.analyses.findById(id);
    if (!a) throw new NotFoundError('Analysis', id);
    return a;
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------
  async ingestContext(
    documents: ReadonlyArray<{
      type: AIContextType;
      content: string;
      source?: string;
      metadata?: Record<string, unknown>;
    }>
  ): Promise<{ ingested: number; deduped: number }> {
    if (documents.length === 0) return { ingested: 0, deduped: 0 };
    const summary = await this.rag.ingest(
      documents.map(d => {
        const md: Record<string, unknown> = {
          type: d.type,
          ...(d.metadata ?? {}),
        };
        if (d.source !== undefined) md['source'] = d.source;
        return { content: d.content, metadata: md };
      })
    );
    for (const d of documents) {
      const aggregate = AIContext.ingest(
        {
          type: d.type,
          content: d.content,
          source: d.source ?? 'inline',
          ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        },
        this.clock
      );
      const existing = await this.contexts.findById(aggregate.id as ContextId);
      if (!existing) {
        await this.contexts.upsert(aggregate);
        this.bus.publishMany(aggregate.drainEvents());
      } else {
        // Dedup — drop the queued event (the projection row is already there).
        aggregate.drainEvents();
      }
    }
    return summary;
  }

  /**
   * Trigger the Python ingestion sidecar. Async; returns when the
   * subprocess exits.
   */
  async runPythonIngestion(since?: string): Promise<void> {
    const spec: Parameters<IngestionBridge['triggerIngestion']>[0] = {};
    if (since !== undefined) spec.since = since;
    await this.ingestion.triggerIngestion(spec);
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------
  /** Health/status surface — back-compat for the existing /health probe. */
  async healthCheck(): Promise<{
    status: string;
    enabled: boolean;
    apiKeyConfigured: boolean;
  }> {
    return {
      status: 'healthy',
      enabled: true,
      apiKeyConfigured: false, // The composition root passes the real flag.
    };
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function classifyErr(
  err: unknown
): import('../domain/analysis').AnalysisError['code'] {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    if (
      c === 'PROVIDER_ERROR' ||
      c === 'BACKPRESSURE' ||
      c === 'RATE_LIMIT_EXCEEDED' ||
      c === 'VALIDATION_ERROR'
    ) {
      if (c === 'RATE_LIMIT_EXCEEDED') return 'RATE_LIMIT';
      if (c === 'BACKPRESSURE') return 'BACKPRESSURE';
      if (c === 'PROVIDER_ERROR') return 'PROVIDER_ERROR';
      if (c === 'VALIDATION_ERROR') return 'VALIDATION_ERROR';
    }
  }
  return 'INTERNAL_ERROR';
}

function readScopeFromLegacy(data: unknown): Scope {
  if (data && typeof data === 'object') {
    const r = data as Record<string, unknown>;
    if (typeof r['clusterId'] === 'string') {
      return { clusterId: r['clusterId'] as Scope['clusterId'] };
    }
  }
  return { clusterId: 'legacy' as Scope['clusterId'] };
}

function mapLegacyStrategy(
  strategy: string,
  type: AnalysisType
): PromptTemplateName {
  switch (strategy) {
    case 'security_focused':
      return 'security_focused';
    case 'performance_optimization':
      return 'performance_optimization';
    case 'cost_optimization':
      return 'cost_optimization';
    case 'compliance':
      return 'compliance';
    case 'comprehensive':
      return 'comprehensive';
    default:
      return PromptComposer.templateForAnalysisType(type);
  }
}

function projectToLegacy(a: Analysis): AIAnalysisResult {
  return {
    insights: a.insights.map(i => i.text),
    recommendations: a.recommendations.map(r => r.text),
    confidence: a.confidence,
    processingTime: a.processingTimeMs,
    timestamp: new Date(a.completedAt ?? a.requestedAt),
    context: {
      strategy: a.strategy.modelId,
      relevantContextCount: a.retrieved.length,
      patternsIdentified: a.predictions.length,
      predictions: a.predictions.map(p => p.text),
    },
    learning: {
      patterns: [],
      newObservations: [],
    },
    predictions: a.predictions.map(p => p.text),
  };
}

// re-export for app.ts
export type { AIContextRef };
