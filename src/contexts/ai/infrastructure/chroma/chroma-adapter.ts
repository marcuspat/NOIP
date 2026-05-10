// ChromaAdapter — anti-corruption layer for ChromaDB.
//
// Speaks the Chroma HTTP API directly via `node:fetch` — we don't pull
// in `@chroma-core/chromadb` because the wire shape we need is small
// and the SDK is not consistently maintained for the HTTP surface.
//
// Falls back to the InMemoryRagStore on construction error so the AI
// service stays available; operators flip `RAG_PROVIDER=chroma` when a
// real Chroma server is reachable at `CHROMA_URL`.

import { BackpressureError, ProviderError } from '../../../../shared/errors';
import type {
  RagDocumentInput,
  RagHit,
  RagIngestSummary,
  RagQueryOptions,
  RagStore,
} from '../../domain/ports/rag-store';
import { withRetry } from '../anthropic/retry';
import { CircuitBreaker } from '../anthropic/circuit-breaker';

export interface ChromaAdapterOptions {
  /** Base URL, e.g. `http://localhost:8000`. */
  baseURL: string;
  /** Collection name. Default: `noip-rag`. */
  collection?: string;
  /** Optional auth token. */
  authToken?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Logger. */
  logger?: { warn(msg: string, meta?: unknown): void };
}

interface ChromaQueryResponse {
  ids?: string[][];
  documents?: string[][];
  distances?: number[][];
  metadatas?: Array<Array<Record<string, unknown> | null>>;
}

export class ChromaAdapter implements RagStore {
  private readonly baseURL: string;
  private readonly collection: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker = new CircuitBreaker();
  private readonly logger: NonNullable<ChromaAdapterOptions['logger']>;

  constructor(opts: ChromaAdapterOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.collection = opts.collection ?? 'noip-rag';
    if (opts.authToken) {
      this.authToken = opts.authToken;
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger ?? { warn: () => undefined };
  }

  async ingest(documents: RagDocumentInput[]): Promise<RagIngestSummary> {
    if (documents.length === 0) return { ingested: 0, deduped: 0 };
    const payload = {
      ids: documents.map((d, i) => d.id ?? `doc-${i}`),
      documents: documents.map(d => d.content),
      metadatas: documents.map(d => d.metadata ?? {}),
    };
    await this.send(`/api/v1/collections/${this.collection}/upsert`, payload);
    return { ingested: documents.length, deduped: 0 };
  }

  async query(text: string, opts: RagQueryOptions): Promise<RagHit[]> {
    const body: Record<string, unknown> = {
      query_texts: [text],
      n_results: Math.max(1, Math.min(50, opts.topK)),
    };
    if (opts.filter) {
      body['where'] = opts.filter;
    }
    const raw = (await this.send(
      `/api/v1/collections/${this.collection}/query`,
      body
    )) as ChromaQueryResponse;
    const ids = raw.ids?.[0] ?? [];
    const docs = raw.documents?.[0] ?? [];
    const metas = raw.metadatas?.[0] ?? [];
    const dists = raw.distances?.[0] ?? [];
    const out: RagHit[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (typeof id !== 'string') continue;
      const distRaw = dists[i];
      const dist = typeof distRaw === 'number' ? distRaw : 1;
      // Chroma returns distance; smaller = closer. Map to [0,1] score.
      const score = Math.max(0, Math.min(1, 1 - dist));
      const docRaw = docs[i];
      out.push({
        id,
        content: typeof docRaw === 'string' ? docRaw : '',
        metadata: metas[i] ?? {},
        score,
      });
    }
    return out;
  }

  async retire(id: string): Promise<void> {
    await this.send(`/api/v1/collections/${this.collection}/delete`, {
      ids: [id],
    });
  }

  private async send(path: string, body: unknown): Promise<unknown> {
    return this.breaker.execute(() =>
      withRetry(
        async () => {
          const res = await this.fetchImpl(this.baseURL + path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.authToken
                ? { authorization: `Bearer ${this.authToken}` }
                : {}),
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500) {
              throw new ProviderError(`Chroma ${res.status}`, {
                status: res.status,
              });
            }
            const text = await res.text().catch(() => '');
            this.logger.warn('chroma semantic error', {
              status: res.status,
              body: text.slice(0, 200),
            });
            throw new ProviderError(`Chroma ${res.status}`, {
              status: res.status,
            });
          }
          if (res.status === 204) return null;
          try {
            return await res.json();
          } catch {
            return null;
          }
        },
        {
          attempts: 3,
          baseMs: 200,
          retriable: e =>
            e instanceof ProviderError &&
            typeof (e.details as Record<string, unknown> | undefined)?.[
              'status'
            ] === 'number' &&
            ((e.details as Record<string, unknown>)['status'] as number) >= 500,
        }
      ).catch(err => {
        if (err instanceof BackpressureError) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(
          err instanceof Error ? err.message : 'chroma error'
        );
      })
    );
  }
}
