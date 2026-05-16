// Prometheus client port — domain-side interface that the
// `PrometheusAdapter` (HTTP API) and `InMemoryPromStub` (tests/bench)
// implement. We only model the queries the SLOComputer needs.

export interface PrometheusInstantQuery {
  query: string;
  /** ISO 8601 timestamp. Defaults to "now" when absent. */
  time?: string;
}

export interface PrometheusBatchResult {
  query: string;
  /** Scalar value (the SLOComputer collapses multi-series PromQL into a
   * scalar via vector aggregation in the query itself). */
  value: number | null;
  /** Optional error message; when present `value` is null. */
  error?: string;
}

export interface PrometheusClient {
  /**
   * Batch-execute a list of instant queries. Implementations should
   * fan-out concurrently where possible. The order of results matches
   * the order of inputs.
   */
  queryBatch(
    queries: ReadonlyArray<PrometheusInstantQuery>
  ): Promise<PrometheusBatchResult[]>;
}
