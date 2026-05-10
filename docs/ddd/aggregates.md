# Aggregate Design Rules

DDD's tactical pattern most often abused. This document records
NOIP's house style for designing aggregates so reviewers can call out
violations consistently.

## What an aggregate is, here

An **aggregate** is a small cluster of entities and value objects
that are loaded, modified, and persisted as a single transactional
unit. Each aggregate has:

- A **root entity** (the only one external code references by id).
- An **aggregate root id** (the only id that crosses aggregate
  boundaries).
- A set of **invariants** that hold true at the end of every
  operation on the aggregate.

## Rules

### 1. One aggregate per Mongoose model file

Each `src/models/*.model.ts` defines exactly one aggregate root and
its embedded entities/value objects. Embedded subdocuments are part
of the aggregate; *referenced* documents (`ObjectId` ref) belong to
another aggregate.

### 2. Reference other aggregates by id only

Inside an aggregate's schema, references to other aggregates use
their **id** (typed alias such as `UserId`, `RoleId`, `ClusterId`).
Never embed another aggregate's full document — that creates a
phantom co-ownership of state.

### 3. Modify one aggregate per request

A single HTTP request should mutate at most one aggregate. If two
aggregates *appear* to need to change atomically, prefer:

- **Eventual consistency** via a domain event (see
  [`domain-events.md`](./domain-events.md)).
- A *new* aggregate that owns the relationship.

Multi-document MongoDB transactions are reserved for cases where
atomicity is genuinely required (rare; documented case-by-case).

### 4. Invariants live in the aggregate

Business rules that protect the aggregate's correctness live in the
aggregate root or its services, not in controllers. Examples:

- A `User` cannot have more than one *default* MFA channel.
- A `Session` is `revoked` ⇒ any attempt to refresh it fails.
- A `Snapshot` cannot be modified after it is finalised.

### 5. Aggregates are loaded fully

When code modifies an aggregate, it loads the full document. Partial
projections are read-only. This rule prevents lost-update bugs from
write-time merges.

### 6. Domain events are part of the aggregate's API

When an aggregate's invariant transition is meaningful to the rest
of the system (e.g. a session was revoked), the aggregate emits a
domain event. The event is published in the same operation that
persists the aggregate change.

### 7. Repository per aggregate

Each aggregate has at most one repository (today: the Mongoose
model + its service methods). External code calls the service, not
the model.

### 8. Anaemic models are a smell

A model whose service is purely CRUD is a hint that we are missing a
domain operation. Look for verbs hidden in controllers ("approve",
"revoke", "rotate", "mark as drift") and pull them down to the
service or aggregate.

## NOIP's aggregates at a glance

| Aggregate                | Root entity (model)               | Owns (embedded / value objects)                              | Bounded context           |
| ------------------------ | --------------------------------- | ------------------------------------------------------------ | ------------------------- |
| **User**                 | `User` (`user.model.ts`)          | `MfaEnrolment`, `BackupCode`, `PasswordHistoryEntry`         | Identity & Access         |
| **Role**                 | `Role` (`role.model.ts`)          | references to `Permission`s                                  | Identity & Access         |
| **Permission**           | `Permission` (`permission.model.ts`) | `Conditions` value object                                | Identity & Access         |
| **Session**              | `Session` (`session.model.ts`)    | `DeviceFingerprint`, `GeoLocation`                           | Identity & Access         |
| **SecurityEvent**        | `SecurityEvent` (`security-event.model.ts`) | `Severity`, `Resolution` (lifecycle value object)  | Security Operations       |
| **Cluster**              | `Cluster` (planned)               | `Endpoint`, `CredentialRef`                                  | Infrastructure Discovery  |
| **Snapshot**             | `Snapshot` (planned)              | many `ResourceRecord`s                                       | Infrastructure Discovery  |
| **DriftReport**          | `DriftReport` (planned)           | many `DriftItem`s                                            | Infrastructure Discovery  |
| **Finding**              | `Finding` (planned)               | `Severity`, `Evidence` references                            | Security Operations       |
| **AIAnalysis**           | `AIAnalysis` (planned)            | `Recommendation`s, `Confidence`                              | AI Intelligence           |
| **ComplianceControl**    | `ComplianceControl` (planned)     | `EvidenceRequirement`s                                       | Compliance & Risk         |
| **Assessment**           | `Assessment` (planned)            | per-control `ControlResult`s                                 | Compliance & Risk         |
| **LoadTest**             | `LoadTest` (planned)              | `MetricSeries` references                                    | Performance & Observability |
| **AuditEvent**           | `AuditEvent` (planned)            | request fingerprint                                          | Audit & Logging           |
| **Report**               | `Report` (planned)                | export shape                                                 | Dashboard & Reporting     |

"Planned" indicates aggregates whose schema is not yet committed but
whose shape is described in the relevant context doc.

## Anti-patterns to reject in review

- **God-aggregate**: one aggregate that ends up holding most of a
  context's data. Split along invariant boundaries.
- **Cross-aggregate transactions**: if you find yourself reaching for
  `session.withTransaction`, justify it in the PR. Default is *no*.
- **Service skipping the aggregate**: a controller that calls
  `Model.updateOne(...)` directly bypasses invariants. Push the
  operation into the service.
- **Foreign-key embedding**: copying another aggregate's data inline
  for "performance". Use a denormalised read model instead, owned
  separately.
