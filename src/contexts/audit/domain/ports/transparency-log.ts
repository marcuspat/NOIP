// Domain port for the tamper-evidence transparency log.
//
// The audit context publishes the latest hash-chain tip per shard to
// an append-only transparency log on a daily cadence (DDD-11 §"Tamper
// evidence"). The log is the public commitment: an external auditor
// can verify that no entry has been altered or deleted by re-fetching
// the chain and matching its tip against the recorded log entry.
//
// Implementations:
//   - In-memory stub (`TransparencyLogStub`) — tests + dev. Holds
//     submissions in a Map and returns deterministic stable indexes.
//   - Sigstore Rekor (`RekorTransparencyLog`) — production. The
//     Rekor HTTP client is loaded dynamically (HTTPS, no SDK
//     dependency) so the stub remains the default and Rekor is
//     opt-in via `TRANSPARENCY_LOG_PROVIDER=rekor`.

/** Inclusive description of a chain tip submitted to the log. */
export interface TransparencyLogSubmission {
  shard: string;
  /** Sequence number of the chain tip (latest appended entry). */
  sequence: number;
  /** The chain hash being committed. Hex SHA-256. */
  tipHash: string;
  /** Producer-side timestamp for the submission. */
  occurredAt: Date;
}

/** Receipt returned by the log once a submission is durable. */
export interface TransparencyLogReceipt {
  /** Log-side identifier (e.g. Rekor UUID, stub index). */
  logId: string;
  /** Index in the underlying Merkle tree (Rekor returns this; stub mirrors it). */
  logIndex: number;
  /** When the log processed the submission. */
  integratedAt: Date;
  /** Provider's signature / inclusion proof. Opaque blob. */
  signature?: string;
}

export interface TransparencyLog {
  /**
   * Submit a chain tip. Idempotent on `(shard, sequence)` — repeated
   * submissions of the same tip MUST return the same `logIndex` so
   * downstream verifiers can dedup safely. Throws on a 5xx upstream
   * (the caller logs + retries on the next tick).
   */
  submit(
    submission: TransparencyLogSubmission
  ): Promise<TransparencyLogReceipt>;

  /**
   * Fetch a previously-submitted receipt by `(shard, sequence)`. Used
   * by the verifier to assert that what's in Mongo today matches what
   * we committed yesterday. `null` when the log has no record.
   */
  lookup(
    shard: string,
    sequence: number
  ): Promise<TransparencyLogReceipt | null>;
}
