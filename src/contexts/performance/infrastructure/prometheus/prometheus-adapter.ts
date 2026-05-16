// PrometheusAdapter — HTTP API client for Prometheus's
// `/api/v1/query` endpoint. Uses Node's native fetch (Node 18+).
//
// Batch behaviour: Prometheus does not expose a batched instant-query
// API, so we fan-out individual requests under a bounded concurrency
// limit. The adapter never throws — per-query failures collapse to a
// `{ value: null, error: '…' }` entry so the SLOComputer can continue
// processing the rest of the batch.

import type {
  PrometheusBatchResult,
  PrometheusClient,
  PrometheusInstantQuery,
} from '../../domain/ports/prometheus-client';

/** Subset of the Prometheus query API response we care about. */
interface PrometheusInstantResponse {
  status: 'success' | 'error';
  errorType?: string;
  error?: string;
  data?: {
    resultType: 'scalar' | 'vector' | 'matrix' | 'string';
    result: unknown;
  };
}

export interface PrometheusAdapterOpts {
  /** Base URL of the Prometheus server (e.g. `http://prom:9090`). */
  baseUrl: string;
  /** Per-request timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Max concurrent requests inside one `queryBatch`. Default 8. */
  concurrency?: number;
  /** Optional override fetch (tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 5_000;

export class PrometheusAdapter implements PrometheusClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PrometheusAdapterOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async queryBatch(
    queries: ReadonlyArray<PrometheusInstantQuery>
  ): Promise<PrometheusBatchResult[]> {
    const out: PrometheusBatchResult[] = new Array(queries.length);
    const chunks = chunk(queries.slice(), this.concurrency);
    let cursor = 0;
    for (const batch of chunks) {
      const results = await Promise.all(batch.map(q => this.queryOne(q)));
      for (const r of results) {
        out[cursor++] = r;
      }
    }
    return out;
  }

  private async queryOne(
    q: PrometheusInstantQuery
  ): Promise<PrometheusBatchResult> {
    const params = new URLSearchParams({ query: q.query });
    if (q.time) params.set('time', q.time);
    const url = `${this.baseUrl}/api/v1/query?${params.toString()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        signal: ctl.signal,
      });
      if (!resp.ok) {
        return { query: q.query, value: null, error: `HTTP ${resp.status}` };
      }
      const body = (await resp.json()) as PrometheusInstantResponse;
      if (body.status !== 'success' || !body.data) {
        return {
          query: q.query,
          value: null,
          error: body.error ?? `prometheus status=${body.status}`,
        };
      }
      const value = parseScalar(body.data);
      return { query: q.query, value };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { query: q.query, value: null, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reduce a Prometheus result to a scalar. We handle the two shapes the
 * SLOComputer's PromQL queries produce: `scalar` (`[ts, "val"]`) and
 * `vector` (`[{ value: [ts, "val"] }, …]`). For vectors with more than
 * one series we average — the SLOComputer should aggregate in PromQL,
 * but we degrade gracefully rather than throwing.
 */
function parseScalar(
  data: NonNullable<PrometheusInstantResponse['data']>
): number | null {
  if (data.resultType === 'scalar') {
    const arr = data.result as [number, string];
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const n = Number(arr[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (data.resultType === 'vector') {
    const arr = data.result as Array<{ value: [number, string] }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const r of arr) {
      const n = Number(r.value?.[1]);
      if (Number.isFinite(n)) {
        sum += n;
        count++;
      }
    }
    return count === 0 ? null : sum / count;
  }
  return null;
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) return [arr.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}
