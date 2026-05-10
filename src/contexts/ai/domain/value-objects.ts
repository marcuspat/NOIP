// Value objects for the AI Analysis context (DDD-08).
//
// Pure data shapes; aggregates and application services compose these.
// The HTTP edge re-projects them onto the legacy `AIAnalysisResult`
// (back-compat) where required.

import type {
  AnalysisId,
  ContextId,
  Instant,
  ClusterId,
  PatternId,
  UserId,
} from '../../../shared/kernel';

// ---------------------------------------------------------------------------
// Cross-context primitives mirrored from Discovery / Security.
// ---------------------------------------------------------------------------

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Scope {
  clusterId: ClusterId;
  namespace?: string;
  kind?: string;
}

// ---------------------------------------------------------------------------
// Analysis taxonomy
// ---------------------------------------------------------------------------

/**
 * Analysis flavours we ship templates for. The legacy enum
 * ('security'|'performance'|'compliance'|'cost') is preserved for the
 * back-compat surface; `comprehensive` is added per DDD-08.
 */
export type AnalysisType =
  | 'security'
  | 'performance'
  | 'compliance'
  | 'cost'
  | 'comprehensive';

export type PromptTemplateName =
  | 'comprehensive'
  | 'security_focused'
  | 'performance_optimization'
  | 'cost_optimization'
  | 'compliance';

/**
 * Strategy captures the *exact* configuration used by a given
 * analysis. Recording it on the aggregate is what makes the analysis
 * reproducible (DDD-08 invariant).
 */
export interface Strategy {
  modelId: string;
  promptTemplateHash: string;
  retrievalPolicy: RetrievalPolicy;
}

export interface RetrievalPolicy {
  /** Top-k retrieval depth. */
  topK: number;
  /** Optional ChromaDB-style metadata filter. */
  filter?: Record<string, unknown>;
  /** Collections to query. Empty array == default per-template config. */
  collections?: string[];
}

// ---------------------------------------------------------------------------
// Tokens, money, embeddings
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export interface Money {
  /** Amount in `currency` units (USD by default). */
  amount: number;
  currency: 'USD';
}

export function zeroMoney(currency: 'USD' = 'USD'): Money {
  return { amount: 0, currency };
}

/** Embedding vector + identifying tag for the model that produced it. */
export interface Embedding {
  vector: number[];
  modelId: string;
}

// ---------------------------------------------------------------------------
// Insights / Recommendations / Predictions
// ---------------------------------------------------------------------------

/**
 * A grounded insight. `supportingContextIds` is mandatory (possibly
 * empty) so the UI can flag insights without supporting context.
 */
export interface Insight {
  text: string;
  supportingContextIds: ContextId[];
  severity: Severity;
  scope?: Scope;
}

export interface Recommendation {
  text: string;
  /** Imperative action verb (e.g. "implement", "patch", "rotate"). */
  action: string;
  references: string[];
}

export interface Prediction {
  text: string;
  /** ISO 8601 duration string ("P30D", "P7D", etc.). */
  horizon: string;
  /** [0, 1] confidence/probability. */
  probability: number;
}

// ---------------------------------------------------------------------------
// Reference shapes
// ---------------------------------------------------------------------------

/** Reference to a retrieved RAG context, with a similarity score. */
export interface AIContextRef {
  id: ContextId;
  score: number;
  type?: string;
  source?: string;
}

export interface ActorRef {
  type: 'user' | 'system' | 'service';
  userId?: UserId;
  serviceAccountId?: string;
}

// ---------------------------------------------------------------------------
// Redaction report
// ---------------------------------------------------------------------------

export interface RedactionReport {
  secretsRedacted: number;
  piiPseudonymised: number;
  idsOpaqued: number;
  /** Total characters scrubbed (for telemetry). */
  bytesScrubbed: number;
}

export function emptyRedactionReport(): RedactionReport {
  return {
    secretsRedacted: 0,
    piiPseudonymised: 0,
    idsOpaqued: 0,
    bytesScrubbed: 0,
  };
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Type tag for stored RAG documents. */
export type AIContextType =
  | 'incident'
  | 'compliance'
  | 'inventory'
  | 'analysis'
  | 'finding'
  | 'general';

// ---------------------------------------------------------------------------
// Reasonable shape for `Pattern` (used by the LearningPattern aggregate).
// ---------------------------------------------------------------------------

/**
 * Re-export the branded ids that live on aggregates here so adapters
 * outside the kernel don't have to import two places.
 */
export type { AnalysisId, PatternId, ContextId, Instant };
