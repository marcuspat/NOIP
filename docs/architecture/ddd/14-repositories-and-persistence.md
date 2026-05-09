# DDD-14: Repositories & Persistence

This document specifies the persistence story for every aggregate, including
collection layout, indexes, transactional boundaries, and cache strategy.

## Persistence stack

| Store | Role |
|-------|------|
| **MongoDB** (replica set) | Authoritative aggregate persistence (ADR-0004). |
| **Redis** (cluster-capable) | Sessions, denylist, rate limit, MFA challenges, hot caches (ADR-0005). |
| **ChromaDB** | RAG corpus (ADR-0013). |
| **Object storage (S3-compatible)** | Audit archive, report artifacts, snapshot cold tier. |

## Repository pattern

Each context exposes its repositories as TypeScript interfaces in
`src/contexts/<name>/domain/repositories/`. Concrete adapters live in
`src/contexts/<name>/infrastructure/`.

```ts
// Example: User repository contract
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByUsername(u: string): Promise<User | null>;
  findByEmail(e: string): Promise<User | null>;
  findByVerificationToken(token: string): Promise<User | null>;
  save(user: User): Promise<void>;       // upsert
  delete(id: UserId): Promise<void>;
}
```

Application services depend on the **interface**; tests substitute an
in-memory fake.

## Collection map (MongoDB)

| Context | Collection | Aggregate |
|---------|------------|-----------|
| IAM | `users` | User |
| IAM | `roles` | Role |
| IAM | `permissions` | Permission |
| IAM | `apiKeys` | ApiKey |
| IAM | `serviceAccounts` | ServiceAccount |
| Discovery | `clusters` | Cluster |
| Discovery | `clusterScans` | ClusterScan |
| Discovery | `resourceSnapshots` | ResourceSnapshot |
| Discovery | `driftReports` | DriftReport |
| Security | `securityScans` | SecurityScan |
| Security | `findings` | Finding |
| Security | `securityPolicies` | SecurityPolicy (current) |
| Security | `securityPolicyVersions` | SecurityPolicy (history) |
| Compliance | `complianceReports` | ComplianceReport |
| AI | `aiAnalyses` | Analysis |
| AI | `learningPatterns` | LearningPattern |
| AI | `aiContexts` | AIContext (projection) |
| Performance | `probes`, `probeResults`, `loadTests`, `slos` | — |
| Dashboard | `dashboards`, `reports` | — |
| Audit | `auditLogs`, `securityEvents`, `retentionPolicies` | — |
| Cross | `outbox` | Domain-event outbox |
| Cross | `migrations` | Migration ledger |

Per ADR-0011, each context will move to its own MongoDB *database* (not just
collections) when it is extracted from the modular monolith. Until then, all
collections live in a single `noip` DB and contexts MUST query only their
own collections.

## Indexes (highlights)

### users
- `{ username: 1 }` unique
- `{ email: 1 }` unique
- `{ status: 1 }`
- `{ "sessions.sessionId": 1 }`
- `{ emailVerificationToken: 1 }`
- `{ passwordResetToken: 1 }`
- `{ createdAt: -1 }`

### sessions (collection separate from `users.sessions` for hot lookup)
- `{ sessionId: 1 }` unique
- `{ userId: 1, isActive: 1 }`
- `{ expiresAt: 1 }` TTL — auto-expire rows past `expiresAt`

### findings
- `{ "scope.clusterId": 1, severity: 1, status: 1 }`
- `{ scanId: 1 }`
- `{ detectedAt: -1 }`
- `{ "resource.kind": 1, "resource.name": 1 }`

### resourceSnapshots
- `{ clusterId: 1, takenAt: -1 }`
- `{ clusterId: 1, hash: 1 }` unique

### auditLogs
- `{ timestamp: -1 }`
- `{ "actor.userId": 1, timestamp: -1 }`
- `{ action: 1, timestamp: -1 }`
- `{ resource: 1, resourceId: 1, timestamp: -1 }`
- `{ "chain.shard": 1, "chain.sequence": 1 }` unique

### securityEvents
- `{ severity: 1, createdAt: -1 }`
- `{ userId: 1, createdAt: -1 }`
- `{ type: 1, createdAt: -1 }`
- `{ resolved: 1 }`

### outbox
- `{ dispatchedAt: 1, occurredAt: 1 }` partial: `{ dispatchedAt: { $exists: false } }`

## Migrations

- Tool: `migrate-mongo` (or hand-rolled in `src/database/migrations/`).
- Migrations are **forward-only** in production; rollback strategy is "fix
  forward".
- Auto-run controlled by `MIGRATIONS_AUTO_RUN=true|false`. In Kubernetes, a
  Job runs migrations before rolling the deployment.
- A lock document in the `migrations` collection prevents two pods from
  applying the same migration concurrently.

## Outbox pattern

Each command handler writes both the aggregate change and any domain events
in the same MongoDB transaction. A dispatcher drains the outbox to the
in-process bus (Phase 1) or broker (Phase 2). Marker `dispatchedAt` is set
when delivery succeeds; failures are retried with exponential backoff.

```ts
session.startTransaction();
await users.updateOne({ _id }, …, { session });
await outbox.insertOne(domainEvent, { session });
await session.commitTransaction();
```

## Caching strategy

| What | Where | TTL | Invalidation |
|------|-------|-----|--------------|
| User effective permissions | Redis `noip:cache:perm:<sessionId>` | 5 min | `iam.permission.escalated`, `iam.role.updated` (pub/sub) |
| Latest cluster snapshot | Redis `noip:cache:snap:<clusterId>` | 60 s | `discovery.cluster.scanned` |
| Security score | Redis `noip:cache:score:<scope>` | 60 s | `security.scan.completed` |
| Widget data | Redis `noip:cache:widget:<id>` | per widget | corresponding domain event |
| AI analysis idempotency | Redis `noip:cache:ai:lock:<hash>` | 5 min | naturally expires |

Cache misses are filled by the application service, never by the controller.

## Backup and DR

- MongoDB: continuous oplog backups + daily snapshots; RPO ≤ 5 min,
  RTO ≤ 1 h.
- Redis: AOF persistence + replicas; ephemeral by design (no business data
  loss tolerance for sessions; users re-login on full data loss).
- ChromaDB: nightly snapshot to object storage; ingestion is idempotent so
  re-build from source data is supported.
- Object storage: cross-region replication for the audit archive bucket;
  Object Lock enforces immutability.

## Test fixtures

- Integration tests use Testcontainers to bring up Mongo/Redis/Chroma.
- Repositories have in-memory implementations (`InMemoryUserRepository`,
  etc.) used by service-level unit tests.
- Seed data lives in `tests/fixtures/<context>/`.
