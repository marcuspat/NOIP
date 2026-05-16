// Domain port for the cold-tier object store that holds archived
// audit-log shards (DDD-11 §"Persistence").
//
// One archive object per (shard, calendar-day): the layout is
// `<provider>://noip-audit-archive/<yyyy>/<mm>/<dd>/<shard>.jsonl.gz`.
// Each line is one canonical-JSON audit entry; the file is gzipped at
// the streaming layer so the producer's memory stays flat regardless
// of how many entries the day contains.
//
// Implementations:
//   - Local filesystem (`LocalFsAuditArchiveStore`) — tests + dev.
//   - S3 (`S3AuditArchiveStore`) — production. AWS SDK is loaded
//     dynamically so it stays an optional peer dependency, matching
//     the discovery context's `S3SnapshotArchiveAdapter` contract.

/**
 * Upload result. `uri` is the durable address (e.g.
 * `s3://noip-audit-archive/2026/05/16/global.jsonl.gz`).
 * Implementations MUST return a stable URI that any later `download`
 * call can resolve.
 */
export interface AuditArchiveUploadResult {
  uri: string;
  size: number;
}

/** Optional metadata an adapter may use to set integrity headers. */
export interface AuditArchiveUploadOpts {
  /** MIME type. Defaults to `application/gzip`. */
  contentType?: string;
  /** SHA-256 hex of the *uncompressed* payload (the canonical-JSONL stream). */
  checksum?: string;
}

export interface AuditArchiveStore {
  /**
   * Upload a serialised audit-log bundle. Returns the durable URI and
   * the byte size that landed on the cold tier (post-compression).
   *
   * Implementations MUST overwrite an existing object at the same key
   * idempotently — a re-run of the archive sweep on the same day is
   * an explicit feature (so an interrupted job can resume).
   */
  upload(
    key: string,
    body: Uint8Array,
    opts?: AuditArchiveUploadOpts
  ): Promise<AuditArchiveUploadResult>;

  /** Cheap existence check used by the verifier before deleting from Mongo. */
  exists(key: string): Promise<boolean>;

  /** Read back for verification / restore. */
  download(key: string): Promise<Uint8Array>;

  /** Enumerate keys under a prefix (e.g. for ops audits + restore tools). */
  list(prefix: string, limit?: number): Promise<string[]>;
}

/**
 * Deterministic key layout. Keeps S3 prefix listings cheap (year /
 * month / day) and ensures two archivers on the same shard for the
 * same day cannot collide.
 */
export function buildAuditArchiveKey(args: {
  shard: string;
  date: Date;
}): string {
  const d = args.date;
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}/${args.shard}.jsonl.gz`;
}
