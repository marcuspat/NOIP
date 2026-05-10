// Domain-side port for the LLM provider.
//
// The AnthropicAdapter (in `infrastructure/anthropic/`) implements this
// port. Domain code never imports `@anthropic-ai/sdk` directly; that
// dependency lives strictly in the adapter so the foreign types do not
// leak above the boundary (DDD-16).

import type {
  AnalysisType,
  Insight,
  PromptTemplateName,
  Recommendation,
  Prediction,
  TokenUsage,
} from '../value-objects';

/**
 * One message of the chat protocol used to talk to the LLM. We keep this
 * minimal — system / user / assistant — because tool use isn't part of
 * the Phase 4 grounded-analysis flow.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * If true, the adapter is free to attach the cache_control directive
   * so providers that support prompt caching (Anthropic) skip recomputing
   * this segment on every request.
   */
  cacheable?: boolean;
}

/**
 * Result returned from the LLM port. The adapter is responsible for
 * translating the provider-native response into this shape; from here
 * everything is domain-pure.
 */
export interface LLMAnalysisResult {
  insights: Insight[];
  recommendations: Recommendation[];
  predictions: Prediction[];
  /** Free-form text (used as fallback on parse-failure). */
  rawText: string;
  /** [0, 1]; the adapter computes a default if the model didn't emit one. */
  confidence: number;
  tokens: TokenUsage;
  /** Effective model id used (the adapter may downgrade for backpressure). */
  modelId: string;
}

/**
 * Inputs to a single LLM call.
 */
export interface LLMAnalyzeRequest {
  analysisType: AnalysisType;
  templateName: PromptTemplateName;
  /** Composed messages — already redacted upstream by the application service. */
  messages: LLMMessage[];
  /** Override default model selection (e.g. tier escalation). */
  model?: string;
  /** Hard cap; default per-adapter. */
  maxTokens?: number;
}

/**
 * The provider-neutral interface. Implementations:
 *   - infrastructure/anthropic/anthropic-adapter.ts (live or stub)
 */
export interface LLMClient {
  analyze(req: LLMAnalyzeRequest): Promise<LLMAnalysisResult>;
}
