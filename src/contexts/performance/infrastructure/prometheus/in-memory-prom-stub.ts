// InMemoryPromStub — in-process Prometheus stand-in used by tests and
// the SLO benchmark. Implementations seed query → value mappings; the
// stub fans-out a batch synchronously and returns the seeded values
// (or an error string for queries that were registered as failing).

import type {
  PrometheusBatchResult,
  PrometheusClient,
  PrometheusInstantQuery,
} from '../../domain/ports/prometheus-client';

export interface InMemoryPromStubOpts {
  /**
   * When the lookup misses, return this value (or null). Tests
   * typically pick `null` so the SLOComputer treats the indicator as
   * missing data.
   */
  default?: number | null;
}

export class InMemoryPromStub implements PrometheusClient {
  private readonly values = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly defaultValue: number | null;

  constructor(opts: InMemoryPromStubOpts = {}) {
    this.defaultValue = opts.default ?? null;
  }

  /** Seed a query result. */
  set(query: string, value: number): this {
    this.values.set(query, value);
    this.errors.delete(query);
    return this;
  }

  /** Seed a query as failing — `value` is null, `error` is `msg`. */
  setError(query: string, msg: string): this {
    this.errors.set(query, msg);
    this.values.delete(query);
    return this;
  }

  /** Reset all seeded values. */
  clear(): void {
    this.values.clear();
    this.errors.clear();
  }

  async queryBatch(
    queries: ReadonlyArray<PrometheusInstantQuery>
  ): Promise<PrometheusBatchResult[]> {
    return queries.map(q => {
      const err = this.errors.get(q.query);
      if (err !== undefined) {
        return { query: q.query, value: null, error: err };
      }
      if (this.values.has(q.query)) {
        return { query: q.query, value: this.values.get(q.query) ?? null };
      }
      return { query: q.query, value: this.defaultValue };
    });
  }
}
