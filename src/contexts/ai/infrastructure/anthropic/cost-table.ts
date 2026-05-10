// Cost table for Anthropic models. Prices are USD per Mtoken (input,
// output, cache reads, cache writes). Update as Anthropic publishes
// new prices. Consumed by the adapter to estimate `Money` per call.

export interface ModelCost {
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million cache-read tokens. */
  cacheReadPerMillion: number;
  /** USD per million cache-write tokens. */
  cacheWritePerMillion: number;
}

/**
 * Default cost table (October 2025 published Anthropic prices).
 * Operators may override on construction of the AnthropicAdapter.
 */
export const DEFAULT_COST_TABLE: Readonly<Record<string, ModelCost>> = {
  'claude-opus-4-1-20250805': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  'claude-sonnet-4-5-20250929': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-3-7-sonnet-20250219': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-3-5-haiku-20241022': {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0,
  },
};

export function estimateCost(
  modelId: string,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
  table: Readonly<Record<string, ModelCost>> = DEFAULT_COST_TABLE
): number {
  const row = table[modelId] ?? DEFAULT_COST_TABLE['claude-3-5-haiku-20241022'];
  if (!row) return 0;
  const million = 1_000_000;
  return (
    (tokens.input / million) * row.inputPerMillion +
    (tokens.output / million) * row.outputPerMillion +
    (tokens.cacheRead / million) * row.cacheReadPerMillion +
    (tokens.cacheWrite / million) * row.cacheWritePerMillion
  );
}
