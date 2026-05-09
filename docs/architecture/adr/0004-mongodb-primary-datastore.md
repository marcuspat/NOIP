# ADR-0004: MongoDB as the primary datastore

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, Data
- **Tags:** persistence, database

## Context and Problem Statement

NOIP persists a heterogeneous set of documents:

- Users, roles, permissions, sessions, MFA secrets, SSO mappings.
- Security events, audit logs, security policies.
- Cached snapshots of Kubernetes resources and inventory state.
- AI analysis results, learning patterns, RAG context references.
- Dashboard configurations and widget definitions.

These documents are deeply nested (a `User` has `sessions`, `ssoProviders`,
`mfaBackupCodes`), evolve frequently as we add MFA methods or AI strategies,
and benefit from per-document atomic updates rather than multi-table
transactions.

## Decision Drivers

- Schema flexibility for fast iteration on auth/AI/security models.
- Native JSON document model maps cleanly onto our TypeScript interfaces.
- Mature ODM (Mongoose) with hooks, validation, indexes, and transaction
  support.
- Operability on Kubernetes via StatefulSet (we already have
  `k8s/database/mongodb-statefulset.yaml`).
- Acceptable horizontal scaling via replica sets and sharding.

## Considered Options

1. **MongoDB (with Mongoose ODM)** — current direction.
2. **PostgreSQL with `jsonb`** — relational with document support.
3. **DynamoDB** — managed, serverless.
4. **CockroachDB** — distributed SQL.

## Decision Outcome

**Chosen option:** **MongoDB**, accessed through **Mongoose** for schema
declarations, validation, and indexes. Each bounded context owns its own
collections (see DDD-14):

| Context | Collections |
|---------|-------------|
| IAM | `users`, `roles`, `permissions`, `sessions`, `apiKeys`, `serviceAccounts` |
| Security & Compliance | `securityEvents`, `securityPolicies`, `complianceReports`, `vulnerabilities` |
| Infrastructure Discovery | `clusters`, `resourceSnapshots`, `namespaces`, `nodes` |
| AI Analysis | `aiAnalyses`, `learningPatterns`, `aiContexts` |
| Dashboard | `dashboards`, `widgets` |
| Audit | `auditLogs` |

Cross-context queries are forbidden at the database level; integration uses
domain events or application-service composition (see DDD-04 and DDD-12).

### Positive Consequences

- Document-shaped models map directly onto TypeScript interfaces in
  `src/types/auth.types.ts`.
- Mongoose pre-save hooks centralize concerns like password hashing and
  `passwordChangedAt` updates (see `src/models/user.model.ts`).
- StatefulSet deployment integrates with the wider Kubernetes-native pattern
  (ADR-0014).

### Negative Consequences / Trade-offs

- Ad-hoc relational queries are awkward — explicitly denormalize where
  read patterns require it (e.g. session list embedded in `User`).
- Multi-document transactions are supported but should be a last resort;
  prefer aggregate-shaped writes (DDD-13).
- Operational expertise required for replica-set election, backups, and
  sharding.

## Pros and Cons of the Options

### MongoDB

- 👍 Document model fits the domain.
- 👍 Mongoose hooks and validation reduce boilerplate.
- 👎 Eventual consistency on read replicas; cross-aggregate transactions cost
  more than in PostgreSQL.

### PostgreSQL + jsonb

- 👍 Strong transactional semantics, mature tooling.
- 👎 Schema migrations more painful for nested documents that change shape
  frequently; `jsonb` is a workaround, not a primary modelling tool.

### DynamoDB

- 👍 Fully managed, predictable latency.
- 👎 Vendor lock-in; coarse access-pattern modelling; on-prem / Kubernetes
  parity not possible.

### CockroachDB

- 👍 Distributed SQL with strong consistency.
- 👎 Relational schema is a worse fit for our deeply nested documents;
  operational complexity not yet justified.

## References

- `src/database/mongodb.ts` — connection/pool configuration.
- `src/models/*` — Mongoose schemas.
- `k8s/database/mongodb-statefulset.yaml` — production deployment.
- ADR-0005 (Redis cache & session storage)
- DDD-14 (Repositories & persistence)
