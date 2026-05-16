// Re-export shim — the HashChainAppender has moved to
// `src/contexts/audit/application/`. This file preserves the legacy
// import path so `src/app.ts` and existing tests keep compiling
// unchanged while DDD-11 lands the bounded-context extraction.
//
// New callers should import from `src/contexts/audit/api`.

export {
  HashChainAppender,
  DEFAULT_SHARD,
  canonicalJson,
  computeEntryHash,
  __testing,
} from '../../contexts/audit/application/hash-chain-appender.service';
export type {
  AuditCollection,
  AuditEntryInput,
  AuditLogger,
  ChainIntegrityReport,
} from '../../contexts/audit/application/hash-chain-appender.service';
