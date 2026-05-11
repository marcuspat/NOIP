// Domain port for the cold-tier object store that holds archived
// `ResourceSnapshot` payloads. Per DDD-06 the `resourceSnapshots`
// collection is the largest table; once a row is older than 90 days
// the SnapshotArchiver uploads it to this store and (subsequently)
// hard-deletes the Mongo row.
//
// Implementations:
//   - S3 (`S3SnapshotArchiveAdapter`) — production. AWS SDK is loaded
//     dynamically so it stays an optional peer dependency.
//   - Local filesystem (`LocalFsSnapshotArchiveAdapter`) — dev/tests.
//
// The port is intentionally small: every method is idempotent and the
// archiver verifies a successful upload via `exists` + `download`.

/**
 * Upload result. `uri` is the durable address (e.g.
 * `s3://noip-discovery-archive/2026/05/cluster-id/snapshot-id.jsonl.gz`).
 * Implementations MUST return a stable URI that any later `download`
 * call can resolve.
 */
export interface SnapshotArchiveUploadResult {
  uri: string;
  size: number;
}

/** Optional metadata an adapter may use to set integrity headers. */
export interface SnapshotArchiveUploadOpts {
  /** MIME type. Defaults to `application/octet-stream` per adapter. */
  contentType?: string;
  /** SHA-256 hex of the *uncompressed* payload. Adapters may pass it as
   * `x-amz-checksum-sha256` (S3) or write a sidecar file (local fs). */
  checksum?: string;
}

export interface SnapshotArchiveStore {
  /**
   * Upload a serialised snapshot bundle. Returns the durable URI and
   * the byte size that landed on the cold tier (post-compression).
   */
  upload(
    key: string,
    body: Uint8Array,
    opts?: SnapshotArchiveUploadOpts
  ): Promise<SnapshotArchiveUploadResult>;

  /** Cheap existence check used by the verifier before deleting from Mongo. */
  exists(key: string): Promise<boolean>;

  /** Read back for verification / restore. */
  download(key: string): Promise<Uint8Array>;

  /** Enumerate keys under a prefix for cron resumes. */
  list(prefix: string, limit?: number): Promise<string[]>;
}

/**
 * Deterministic key layout for the archiver. Keeps S3 prefix listings
 * cheap (year / month / cluster) and ensures two archivers cannot
 * collide.
 */
export function buildArchiveKey(args: {
  clusterId: string;
  snapshotId: string;
  takenAt: Date;
}): string {
  const yyyy = String(args.takenAt.getUTCFullYear()).padStart(4, '0');
  const mm = String(args.takenAt.getUTCMonth() + 1).padStart(2, '0');
  return `discovery/${yyyy}/${mm}/${args.clusterId}/${args.snapshotId}.jsonl.gz`;
}
