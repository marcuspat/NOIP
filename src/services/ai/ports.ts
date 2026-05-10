/**
 * AI memory adapter ports — see ADR-0011
 * (docs/adr/0011-agentdb-and-reasoningbank-adapter-pattern.md).
 *
 * These interfaces let `AIService` be exercised in tests without a real
 * vector DB or Anthropic API. Concrete adapters live alongside this file
 * (e.g. `mock-agentdb.adapter.ts`); production adapters can be added in
 * the same shape without touching the service.
 */

/**
 * Vector memory store. Implementations should treat `vector` as an opaque
 * embedding and `payload`/`metadata` as user-supplied data.
 */
export interface IAgentDB {
  /**
   * Insert (or replace) a vector + payload. Returns the assigned id, which
   * the caller can later pass to `delete`.
   */
  upsert(
    vector: number[],
    payload: unknown,
    metadata?: Record<string, unknown>
  ): Promise<string>;

  /**
   * Return the top-`k` nearest entries to `vector`, optionally narrowed by
   * `filter` (shallow equality on `metadata`). Score is implementation-
   * defined but should be higher = more similar.
   */
  query(
    vector: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<
    Array<{
      id: string;
      score: number;
      payload: unknown;
      metadata?: Record<string, unknown>;
    }>
  >;

  /** Remove an entry by id. No-op if it does not exist. */
  delete(id: string): Promise<void>;

  /** Total number of stored entries. */
  count(): Promise<number>;
}

/**
 * Experience log used to learn which strategies have worked for which
 * contexts. Implementations should be cheap to write and ranked-read.
 */
export interface IReasoningBank {
  /** Record the outcome of applying a strategy to a context. */
  recordExperience(input: {
    context: unknown;
    strategy: { id: string; description: string };
    outcome: { success: boolean; notes?: string };
  }): Promise<void>;

  /**
   * Return strategies previously seen for `context`, ranked by an
   * implementation-defined `weight` (higher = better recommendation).
   */
  recommendStrategy(
    context: unknown
  ): Promise<
    Array<{ strategy: { id: string; description: string }; weight: number }>
  >;

  /** Total number of recorded experiences. */
  count(): Promise<number>;
}

/**
 * Minimal LLM client. Lets `AIService` swap between Anthropic, a mock,
 * or any other provider without leaking provider-specific types.
 */
export interface ILLMClient {
  complete(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{
    text: string;
    finishReason: 'stop' | 'length' | 'error';
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    modelUsed: string;
  }>;
}
