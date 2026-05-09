# DDD-13: Aggregate Catalogue

A consolidated reference of every aggregate in NOIP, the consistency
boundary it defines, and the rules that govern modifications. Use this as
the single index when designing new use cases.

## Aggregate design rules (applied platform-wide)

We follow Vaughn Vernon's *Effective Aggregate Design* heuristics:

1. **Model true invariants in consistency boundaries.** An aggregate is the
   smallest set of objects that must be transactionally consistent.
2. **Design small aggregates.** Default to one entity unless an invariant
   forces more.
3. **Reference other aggregates by identity.** Cross-aggregate references are
   IDs, not object pointers.
4. **Update one aggregate per transaction.** Cross-aggregate consistency is
   eventual, mediated by domain events.
5. **Use domain events to propagate change.** Side effects in other
   aggregates flow through the event bus.

## Catalogue

| Context | Aggregate | Root entity | Owns | Notes |
|---------|-----------|-------------|------|-------|
| IAM | **User** | User | Sessions[], SSOProviderLinks[], MFA secret/backup-codes | Roles & permissions referenced by id. |
| IAM | **Role** | Role | parentRoles[] (ids), permission refs | Hierarchy is acyclic. |
| IAM | **Permission** | Permission | conditions map | Globally unique `(resource, action)`. |
| IAM | **ApiKey** | ApiKey | permissions refs | Owner = user or service account. |
| IAM | **ServiceAccount** | ServiceAccount | role refs | API-key based actor. |
| Discovery | **Cluster** | Cluster | credentials ref | Connection metadata. |
| Discovery | **ClusterScan** | ClusterScan | counts | Bounded to one snapshot. |
| Discovery | **ResourceSnapshot** | ResourceSnapshot | KubernetesResourceRecord[] | Immutable. |
| Discovery | **DriftReport** | DriftReport | ResourceChange[] | References two snapshots. |
| Security | **SecurityScan** | SecurityScan | counts | References snapshot + policy version. |
| Security | **Finding** | Finding | Evidence | Lifecycle: open → ack/suppressed → resolved. |
| Security | **SecurityPolicy** | SecurityPolicy | config, version log | Versions immutable. |
| Compliance | **ComplianceReport** | ComplianceReport | ControlAssessment[] | Derived; signed reports immutable. |
| AI | **Analysis** | Analysis | Insight[], Recommendation[], Prediction[], retrieved refs | Reproducible by Strategy + retrieved IDs. |
| AI | **LearningPattern** | LearningPattern | embedding, metadata | Soft-delete on confidence drop. |
| AI | **AIContext** (projection) | AIContext | embedding, metadata | Mongo projection of Chroma corpus. |
| Performance | **Probe** | Probe | schedule, config | Enabled/disabled. |
| Performance | **ProbeResult** | ProbeResult | measurements | TTL-pruned. |
| Performance | **LoadTest** | LoadTest | summary | Immutable post-run. |
| Performance | **SLO** | SLO | indicators, target | Computed budget. |
| Dashboard | **Dashboard** | Dashboard | Widget[], share policy | Per-owner mutability. |
| Dashboard | **Report** | Report | artifactUri | Artifact immutable. |
| Audit | **AuditLogEntry** | AuditLogEntry | hash chain, details | Append-only. |
| Audit | **SecurityEvent** | SecurityEvent | details | Resolution lifecycle. |
| Audit | **RetentionPolicy** | RetentionPolicy | — | Tighten-only. |

## Identifiers

All identifiers are **UUIDv7** (time-sortable, k-anonymous) **branded** in
TypeScript:

```ts
type UserId      = string & { readonly _t: 'UserId' };
type RoleId      = string & { readonly _t: 'RoleId' };
type SessionId   = string & { readonly _t: 'SessionId' };
type FindingId   = string & { readonly _t: 'FindingId' };
// …
```

Branded types prevent accidental misuse (`getUser(findingId)` is a compile
error).

## Lifecycle hooks

The Mongoose `pre('save')` hooks centralise behaviours that belong at the
aggregate boundary:

- `User`: hash password if modified; update `passwordChangedAt`; cap
  `sessions` length.
- `SecurityPolicy`: bump `version` and append the prior version to a
  versions sub-collection.
- `Finding`: refuse `update` once `status = 'resolved'` (only `lastSeenAt`
  movement is allowed).
- `AuditLogEntry`: refuse update or delete; computed `chain.currentHash` on
  insert.

## Concurrency

- Optimistic locking with Mongoose `__v` (versionKey) on every aggregate
  root.
- Conflict resolution returns `409 Conflict` to the caller with a typed
  `OptimisticLockError`; clients reload and retry.
- High-write aggregates (`AuditLogEntry`) use a single-writer-per-shard
  approach to avoid lock contention on the chain hash.

## Transactions

- A single MongoDB session/transaction per command handler.
- Cross-aggregate side effects are produced as domain events, persisted
  *inside* the transaction in the producer's outbox, and dispatched after
  commit.
