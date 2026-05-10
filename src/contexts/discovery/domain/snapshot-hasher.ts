// Canonical-JSON SHA-256 hasher for `ResourceSnapshot`.
//
// Stability requirements (DDD-06 invariants):
//   1. Re-hashing the same set of records (in any order) MUST produce the
//      same hex digest. Records sort lexicographically by
//      (apiVersion, kind, namespace, name).
//   2. Field-order inside each record MUST NOT change the hash. We
//      stringify with sorted keys.
//   3. The output is lowercase hex.
//
// Optimisation: for snapshots > ~100k records the streaming path
// (`hashStream`) hashes record-by-record so we don't allocate a single
// 100MB+ string. Defaults to the streaming path; the simple variant is
// kept for the unit-test harness because it's easier to reason about.

import { createHash } from 'crypto';
import type {
  ContentHash,
  KubernetesResourceRecord,
} from './value-objects';
import { asContentHash } from './value-objects';

/**
 * Canonical stringify with sorted keys. Mirrors RFC 8785 (JCS) closely
 * enough for our purposes; we don't have to round-trip with another
 * implementation. Numbers, booleans, strings, null are stringified by
 * `JSON.stringify` directly. Arrays preserve order. Object keys sort
 * lexicographically.
 *
 * Cycles are not supported (they should never occur in our records);
 * the function will throw via stack overflow if you feed it one.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    // Match JSON: NaN/Infinity become null. Avoids NaN making a
    // snapshot hash non-reproducible.
    if (!Number.isFinite(value as number)) return 'null';
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const inner = value.map((v) => canonicalStringify(v)).join(',');
    return `[${inner}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(`${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  // Fallback for symbol/function/bigint: not part of the domain shape.
  return JSON.stringify(String(value));
}

/**
 * Sort key — we sort records by `(apiVersion, kind, namespace, name)`
 * before hashing. `namespace` may be undefined for cluster-scoped
 * resources; we coerce to '' for stable comparison.
 */
function compareRecords(
  a: KubernetesResourceRecord,
  b: KubernetesResourceRecord
): number {
  const k = (
    [
      [a.apiVersion, b.apiVersion],
      [a.kind, b.kind],
      [a.namespace ?? '', b.namespace ?? ''],
      [a.name, b.name],
    ] as const
  ).find(([x, y]) => x !== y);
  if (!k) return 0;
  return k[0] < k[1] ? -1 : 1;
}

export class SnapshotHasher {
  /**
   * Returns a hex sha256 of the canonical JSON of `records`. The
   * threshold for switching to the streaming path is configurable so
   * tests can exercise both branches.
   */
  hash(records: KubernetesResourceRecord[], opts?: { streamingThreshold?: number }):
    ContentHash {
    const threshold = opts?.streamingThreshold ?? 100_000;
    const sorted = [...records].sort(compareRecords);
    if (sorted.length >= threshold) {
      return this.hashStream(sorted);
    }
    return this.hashSimple(sorted);
  }

  private hashSimple(sorted: KubernetesResourceRecord[]): ContentHash {
    const json = canonicalStringify(sorted);
    return asContentHash(createHash('sha256').update(json).digest('hex'));
  }

  /**
   * Streams the canonical bytes record-by-record into the hasher.
   * Avoids allocating the full canonical string when the snapshot is
   * very large.
   */
  private hashStream(sorted: KubernetesResourceRecord[]): ContentHash {
    const h = createHash('sha256');
    h.update('[');
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) h.update(',');
      h.update(canonicalStringify(sorted[i]));
    }
    h.update(']');
    return asContentHash(h.digest('hex'));
  }
}
