import { IAgentDB } from './ports';

interface Entry {
  id: string;
  vector: number[];
  payload: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * In-memory `IAgentDB` implementation used in tests and local dev.
 *
 * Determinism: results depend only on insertion order, so a sequence of
 * `upsert`/`query` calls with the same inputs always returns the same ids
 * and scores. There is no randomness or wall-clock involvement.
 *
 * Filtering: `query`'s `filter` argument is applied as shallow equality
 * over the entry's `metadata`. An entry passes only if every key in
 * `filter` exists on its metadata with a strictly-equal (`===`) value.
 * Entries with no metadata are excluded whenever a filter is provided.
 */
export class MockAgentDB implements IAgentDB {
  private entries: Entry[] = [];
  private nextId = 1;

  async upsert(
    vector: number[],
    payload: unknown,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const id = `mock-agentdb-${this.nextId++}`;
    const entry: Entry = { id, vector: [...vector], payload };
    if (metadata !== undefined) {
      entry.metadata = { ...metadata };
    }
    this.entries.push(entry);
    return id;
  }

  async query(
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
  > {
    const candidates = filter
      ? this.entries.filter(e => matchesFilter(e.metadata, filter))
      : this.entries;

    const scored = candidates.map(e => ({
      id: e.id,
      score: cosineSimilarity(vector, e.vector),
      payload: e.payload,
      metadata: e.metadata,
    }));

    // Sort by score desc; ties broken by id (insertion order is encoded
    // in the numeric suffix) for determinism.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return scored.slice(0, Math.max(0, k));
  }

  async delete(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
  }

  async count(): Promise<number> {
    return this.entries.length;
  }
}

function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>
): boolean {
  if (!metadata) return false;
  for (const key of Object.keys(filter)) {
    if (metadata[key] !== filter[key]) return false;
  }
  return true;
}

function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}
