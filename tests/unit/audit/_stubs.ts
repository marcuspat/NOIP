// Shared stubs for the audit unit tests.
//
// We deliberately avoid `mongodb-memory-server` to keep the dev surface
// lean. The collection stub captures inserted documents in-memory and
// supports the small subset of operations `HashChainAppender` calls.

import type { AuditCollection } from '../../../src/services/audit/hash-chain-appender.service';
import type { AuditLogEntry } from '../../../src/models/audit-log.model';

export class InMemoryAuditCollection implements AuditCollection {
  public readonly entries: AuditLogEntry[] = [];

  async findOne(
    filter: Record<string, unknown>,
    options?: { sort?: Record<string, 1 | -1> }
  ): Promise<AuditLogEntry | null> {
    const matches = this.entries.filter(e => filterMatches(e, filter));
    if (options?.sort && 'chain.sequence' in options.sort) {
      const dir = options.sort['chain.sequence'] ?? 1;
      // Mongoose semantics: 1 = ascending, -1 = descending. Multiplying
      // the comparator by `dir` yields the requested order, and we then
      // take the *first* element (Mongo's `findOne+sort` returns the
      // first match after sorting).
      matches.sort((a, b) => (a.chain.sequence - b.chain.sequence) * dir);
    }
    return matches.length > 0 ? (matches[0] ?? null) : null;
  }

  async insertOne(entry: AuditLogEntry): Promise<{ insertedId: unknown }> {
    // Enforce the unique (shard, sequence) constraint that the Mongo
    // index would otherwise enforce in production.
    const dup = this.entries.find(
      e =>
        e.chain.shard === entry.chain.shard &&
        e.chain.sequence === entry.chain.sequence
    );
    if (dup) {
      const err: Error & { code?: number } = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    this.entries.push(entry);
    return { insertedId: this.entries.length - 1 };
  }

  async findRange(
    shard: string,
    fromSeq: number,
    toSeq: number
  ): Promise<AuditLogEntry[]> {
    return this.entries
      .filter(
        e =>
          e.chain.shard === shard &&
          e.chain.sequence >= fromSeq &&
          e.chain.sequence <= toSeq
      )
      .sort((a, b) => a.chain.sequence - b.chain.sequence);
  }

  /** Test helper: tamper with an entry's body so the chain breaks. */
  mutateAt(sequence: number, mutator: (e: AuditLogEntry) => void): void {
    const target = this.entries.find(e => e.chain.sequence === sequence);
    if (!target) throw new Error(`no entry at sequence ${sequence}`);
    mutator(target);
  }
}

function filterMatches(
  entry: AuditLogEntry,
  filter: Record<string, unknown>
): boolean {
  for (const [path, want] of Object.entries(filter)) {
    const actual = readPath(entry, path);
    if (actual !== want) return false;
  }
  return true;
}

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export class CapturingLogger {
  public readonly events: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
    meta?: Record<string, unknown>;
  }> = [];

  info(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'info', message, meta }
        : { level: 'info', message }
    );
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'warn', message, meta }
        : { level: 'warn', message }
    );
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.events.push(
      meta !== undefined
        ? { level: 'error', message, meta }
        : { level: 'error', message }
    );
  }
}
