# DDD-12: Cross-context Domain Events

This document is the **published language** for domain events that cross
bounded contexts. The envelope is part of the [Shared Kernel](./04-context-map.md#shared-kernel)
and may not be changed without sign-off from each context.

## Envelope

```ts
interface DomainEvent<T = unknown> {
  /** Globally unique, time-sortable id (UUIDv7). */
  id: string;
  /** '<context>.<aggregate>.<change>' — see registry below. */
  type: string;
  /** When the event happened in the producer's clock (UTC ISO 8601). */
  occurredAt: string;
  /** Origin context (e.g. 'iam'). */
  context: string;
  /** Aggregate type ('user', 'session', 'finding', …). */
  aggregateType: string;
  /** Aggregate id. */
  aggregateId: string;
  /** Who/what triggered it. */
  actor?: { userId?: string; serviceAccountId?: string; system?: true };
  /** Event-specific payload. */
  payload: T;
  /** Correlation id (often the request id). */
  correlationId?: string;
  /** Causation id — the id of the event that caused this one. */
  causationId?: string;
  /** Schema version for the payload. Increment additively. */
  schemaVersion: number;
}
```

## Versioning rules

1. **Additive only** — never remove a field or change its type. New consumers
   tolerate unknown fields.
2. To make a breaking change, publish a *new* event type (`…v2`) for an
   overlap period, then deprecate the old.
3. `schemaVersion` increments on additive change; consumers should check it
   only when reading optional fields they need.

## Delivery semantics

- In-process today: **at-most-once** with synchronous handler errors logged.
- Outbox-backed (target): **at-least-once**; consumers must dedupe by `id`.
- Ordering: events from the same `(aggregateType, aggregateId)` are delivered
  in occurrence order; cross-aggregate ordering is not guaranteed.

## Registry

Below is the canonical event catalogue. Producers must use exactly these
type strings.

### IAM

| Type | Payload (excerpt) | Notes |
|------|-------------------|-------|
| `iam.user.registered` | `{ userId, email, username }` | Status `pending_verification`. |
| `iam.user.email_verified` | `{ userId }` | |
| `iam.user.deactivated` | `{ userId, reason }` | |
| `iam.session.opened` | `{ userId, sessionId, deviceFingerprint, ipAddress, geo }` | |
| `iam.session.closed` | `{ userId, sessionId, reason }` | |
| `iam.session.suspicious` | `{ userId, sessionId, signals[] }` | |
| `iam.login.failed` | `{ usernameOrEmail, ipAddress, reason }` | Triggers lockout policy. |
| `iam.login.succeeded` | `{ userId, sessionId }` | |
| `iam.account.locked` | `{ userId, lockedUntil }` | |
| `iam.account.unlocked` | `{ userId }` | |
| `iam.password.changed` | `{ userId, by }` | Audit + revoke other sessions. |
| `iam.password.reset_requested` | `{ userId }` | |
| `iam.password.reset_confirmed` | `{ userId }` | |
| `iam.mfa.enrolment_started` | `{ userId, method }` | |
| `iam.mfa.enabled` | `{ userId, method }` | |
| `iam.mfa.disabled` | `{ userId, method }` | |
| `iam.mfa.verification_success` | `{ userId, method, sessionId }` | |
| `iam.mfa.verification_failed` | `{ userId, method, ipAddress }` | Threat-detection signal. |
| `iam.token.revoked` | `{ userId, jti, reason }` | |
| `iam.permission.escalated` | `{ userId, addedPermissions[] }` | Forces session refresh. |
| `iam.role.created` | `{ roleId, name, isSystem }` | |
| `iam.role.updated` | `{ roleId, changes }` | |
| `iam.role.deleted` | `{ roleId }` | |
| `iam.permission.granted` | `{ userId, permissionId }` | |
| `iam.permission.revoked` | `{ userId, permissionId }` | |
| `iam.apikey.issued` | `{ keyId, owner, expiresAt? }` | |
| `iam.apikey.revoked` | `{ keyId }` | |
| `iam.sso.linked` | `{ userId, provider, providerUserId }` | |
| `iam.sso.unlinked` | `{ userId, provider }` | |

### Discovery

| Type | Payload (excerpt) |
|------|-------------------|
| `discovery.cluster.registered` | `{ clusterId, endpoint }` |
| `discovery.cluster.scan_started` | `{ clusterId, scanId }` |
| `discovery.cluster.scanned` | `{ clusterId, scanId, snapshotId, counts }` |
| `discovery.cluster.scan_failed` | `{ clusterId, scanId, error }` |
| `discovery.snapshot.archived` | `{ snapshotId, archiveUri }` |
| `discovery.drift.detected` | `{ clusterId, driftId, highestSeverity, changeCount }` |

### Security

| Type | Payload (excerpt) |
|------|-------------------|
| `security.scan.started` | `{ scanId, scope }` |
| `security.scan.completed` | `{ scanId, scope, counts, score }` |
| `security.scan.failed` | `{ scanId, scope, error }` |
| `security.finding.opened` | `{ findingId, scanId, severity, resource, policyId }` |
| `security.finding.acknowledged` | `{ findingId, by, note? }` |
| `security.finding.suppressed` | `{ findingId, by, until, justification }` |
| `security.finding.resolved` | `{ findingId, resolvedAt, by? }` |
| `security.policy.created` | `{ policyId, type, version }` |
| `security.policy.updated` | `{ policyId, version }` |
| `security.policy.disabled` | `{ policyId }` |

### Compliance

| Type | Payload (excerpt) |
|------|-------------------|
| `compliance.report.generated` | `{ reportId, framework, scope, overall }` |
| `compliance.report.signed` | `{ reportId, by }` |
| `compliance.report.expired` | `{ reportId }` |

### AI

| Type | Payload (excerpt) |
|------|-------------------|
| `ai.analysis.requested` | `{ analysisId, type, scope, requestedBy }` |
| `ai.analysis.completed` | `{ analysisId, type, scope, confidence, processingTimeMs }` |
| `ai.analysis.failed` | `{ analysisId, error }` |
| `ai.context.ingested` | `{ contextId, type, source }` |
| `ai.context.retired` | `{ contextId, reason }` |
| `ai.pattern.learned` | `{ patternId, type, confidence }` |
| `ai.pattern.deprecated` | `{ patternId, reason }` |
| `ai.cost.budget_breached` | `{ scope, period, cost, budget }` |

### Performance

| Type | Payload (excerpt) |
|------|-------------------|
| `performance.probe.failed` | `{ probeId, target, failureReason }` |
| `performance.slo.breached` | `{ sloId, burnRate, remainingBudget }` |
| `performance.slo.recovered` | `{ sloId }` |
| `performance.load_test.completed` | `{ loadTestId, summary }` |

### Dashboard

| Type | Payload (excerpt) |
|------|-------------------|
| `dashboard.created` | `{ dashboardId, ownedBy }` |
| `dashboard.updated` | `{ dashboardId, changes }` |
| `dashboard.deleted` | `{ dashboardId }` |
| `dashboard.shared` | `{ dashboardId, with }` |
| `report.generated` | `{ reportId, kind, scope, format }` |

### Audit (system)

| Type | Payload (excerpt) |
|------|-------------------|
| `audit.chain.broken` | `{ shard, atSequence, expectedHash, actualHash }` |
| `audit.archive.completed` | `{ from, to, archiveUri }` |

## Bus implementation

- **Phase 1 (today):** in-process EventBus (`src/shared/events/`).
- **Phase 2:** broker-backed (NATS JetStream first; Kafka if needed).
  Producers write through an outbox pattern; a dispatcher drains the outbox
  to the broker. Consumers subscribe per topic.
- **Phase 3:** schema registry (JSON Schema or Protobuf) and CI gates that
  prevent breaking changes.

## Subscriber overview

| Event prefix | Audit | Dashboard | AI | Security | Notifications |
|--------------|:----:|:---------:|:--:|:--------:|:------------:|
| `iam.*` | ✓ | partial | — | partial | partial |
| `discovery.*` | ✓ | ✓ | ✓ | ✓ | partial |
| `security.*` | ✓ | ✓ | ✓ | (self) | ✓ |
| `compliance.*` | ✓ | ✓ | — | (self) | partial |
| `ai.*` | ✓ | ✓ | (self) | — | — |
| `performance.*` | ✓ | ✓ | partial | — | ✓ |
| `dashboard.*` | ✓ | (self) | — | — | — |
