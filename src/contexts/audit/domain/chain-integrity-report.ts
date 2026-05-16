// Result of `AuditService.verifyChainIntegrity` / `HashChainAppender.verifyRange`.
// Co-located so consumers don't have to import application-internal
// shapes from the appender's file.

export interface ChainIntegrityReport {
  /** True iff every recomputed hash matched and no `previousHash` link broke. */
  ok: boolean;
  shard: string;
  fromSequence: number;
  toSequence: number;
  /** Number of entries actually verified before the loop terminated. */
  checked: number;
  /** Sequence at which the chain broke (only populated when `ok === false`). */
  brokenAtSequence?: number;
  /** Expected hash at the break point. */
  expectedHash?: string;
  /** Actual hash at the break point. */
  actualHash?: string;
}
