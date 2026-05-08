# ADR-0004: MongoDB as the primary datastore

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** persistence, datastore

## Context

The data NOIP stores is heterogeneous and evolving:

- **User / role / permission / session** documents with optional fields
  (MFA enrolment, SSO ids, password history, device fingerprints).
- **Security events** with free-form payloads that vary by event type.
- **Compliance evidence** that differs per framework and per control.
- **Discovery snapshots** of Kubernetes clusters whose schema mirrors the
  Kubernetes API and varies by resource kind.

Two characteristics dominate:

1. **Schema flexibility** — each entity has stable identity but optional
   evolving fields. New compliance frameworks should not require migrations
   that rewrite millions of rows.
2. **Document-shaped reads** — most reads return a single aggregate
   (one user, one session, one event), not multi-table joins.

## Decision

We use **MongoDB 6.0+** (replica set) as the primary persistent datastore,
accessed through **Mongoose 8.x** as ODM. Each bounded context owns a
database and a set of collections; cross-context reads go through service
APIs, not direct collection access.

Connection lifecycle and pooling live in `src/database/mongodb.ts`. Schema
versioning lives in `src/database/migrations/` (e.g.
`001_initial_schema.ts`).

## Alternatives considered

- **PostgreSQL** — strong consistency, mature tooling, JSONB for flexible
  fields. Rejected because we did not need transactional joins across
  contexts, and per-framework compliance evidence is naturally document-
  shaped. Reconsider if the system grows multi-aggregate transactions.
- **DynamoDB / Cosmos DB** — would force us to a single cloud and impose a
  partition-key design we don't have a strong handle on yet.
- **MongoDB without Mongoose** — pure driver. Rejected because Mongoose's
  schema, hooks (e.g. password hashing pre-save in `user.model.ts`), and
  TypeScript integration save substantial code.

## Consequences

### Positive
- Schema flexibility for evolving entities and compliance frameworks.
- Mongoose hooks centralise concerns like timestamping and password
  hashing.
- Replica sets provide read scaling and high availability with low ops
  overhead.

### Negative / costs
- No cross-collection ACID transactions by default (MongoDB supports
  multi-document transactions on replica sets but they are slower; we
  avoid them).
- Aggregation framework is powerful but has a learning curve for joins
  and pipelines.

### Risks and mitigations
- *Schema drift.* All schemas live in `src/models/` with explicit
  Mongoose definitions; ad-hoc fields are rejected in PR review.
- *Index bloat.* All indexes are declared in the model file with a
  justification comment.
- *Backup discipline.* StatefulSet PVCs are snapshotted; runbook in
  `docs/OPERATIONAL_RUNBOOKS.md`.

## References

- `src/database/mongodb.ts` — connection, pooling, replica set config.
- `src/models/*.model.ts` — domain schemas.
- `k8s/mongodb-statefulset.yaml` — production topology.
