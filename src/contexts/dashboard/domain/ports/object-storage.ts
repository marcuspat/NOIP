// Domain port for the object store that holds rendered report
// artifacts. The same surface accepts both local-filesystem (dev /
// tests) and S3 (production) adapters; the composite picks one based
// on env config.
//
// We expose `putStream` so the report service can pipe CSV / HTML
// straight through without buffering; `put` is the buffered variant.
// Implementations MUST return a stable URI from `put` / `putStream`
// that any later `get` call can resolve.

import type { Readable } from 'node:stream';

export interface ObjectPutOpts {
  /** MIME type. Defaults vary by adapter (commonly application/octet-stream). */
  contentType?: string;
  /** Optional content length for adapters that require it. */
  contentLength?: number;
}

export interface ObjectPutResult {
  uri: string;
  size: number;
}

/**
 * Minimal object-store contract. The dashboard adapter is intentionally
 * separate from the discovery `SnapshotArchiveStore` because the two
 * tiers have different key layouts and different durability needs.
 */
export interface ObjectStorageAdapter {
  put(
    key: string,
    body: Uint8Array,
    opts?: ObjectPutOpts
  ): Promise<ObjectPutResult>;

  putStream(
    key: string,
    body: Readable,
    opts?: ObjectPutOpts
  ): Promise<ObjectPutResult>;

  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array>;
  getStream(key: string): Promise<Readable>;
}

/**
 * Builds a deterministic key for a report artifact. We shard by year /
 * month to keep S3 prefix listings cheap and avoid hot partitions.
 */
export function buildReportKey(args: {
  reportId: string;
  generatedAt: Date;
  extension: string;
}): string {
  const yyyy = String(args.generatedAt.getUTCFullYear()).padStart(4, '0');
  const mm = String(args.generatedAt.getUTCMonth() + 1).padStart(2, '0');
  return `dashboard/reports/${yyyy}/${mm}/${args.reportId}.${args.extension}`;
}
