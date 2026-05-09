# ADR-0018: Security events as first-class domain events

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security, Platform engineering
- **Tags:** security, events, ddd

## Context and Problem Statement

Authentication and authorization actions emit signals that downstream
contexts must react to: alerting (`SUSPICIOUS_LOGIN`), notification
(`MFA_DISABLED`), session invalidation (`PASSWORD_CHANGE`), or analytics
(`LOGIN_SUCCESS`). The `SecurityEventType` enum in
`src/types/auth.types.ts` already enumerates the relevant cases.

Treating these as ad-hoc log lines couples reactions to grep patterns and
makes them invisible to the type system. They are **domain events**.

## Decision Drivers

- Strong typing across producers and consumers.
- Decoupled subscribers (Audit, Notifications, Threat Detection, Dashboard).
- In-process today; broker-backed (NATS / Kafka) when contexts split.
- Compatibility with the IAM aggregate's invariant boundary.

## Considered Options

1. **Domain events with an in-process event bus** (today) and a contract-
   stable serialised form for future broker adoption.
2. **No formal events — just log lines.**
3. **Database-trigger-driven events.**

## Decision Outcome

**Chosen option:** Option 1.

### Event taxonomy

Events use `<context>.<aggregate>.<change>` naming. Initial set
(superset of `SecurityEventType`):

| Event | Producer | Sample subscribers |
|-------|----------|--------------------|
| `iam.session.opened` | IAM (login success) | Audit, Dashboard |
| `iam.session.closed` | IAM (logout) | Audit |
| `iam.session.suspicious` | IAM (geo / device anomaly) | Audit, Notifications |
| `iam.mfa.enabled` | IAM | Audit, Notifications |
| `iam.mfa.disabled` | IAM | Audit, Notifications |
| `iam.mfa.verification_failed` | IAM | Audit, Threat Detection |
| `iam.account.locked` | IAM | Audit, Notifications |
| `iam.account.unlocked` | IAM | Audit |
| `iam.permission.escalated` | IAM | Audit |
| `iam.password.changed` | IAM | Audit, Notifications, IAM (revoke other sessions) |
| `iam.password.reset_requested` | IAM | Audit, Notifications |
| `iam.token.revoked` | IAM | Audit |
| `discovery.cluster.scanned` | Discovery | Dashboard, AI |
| `discovery.drift.detected` | Discovery | Audit, Notifications |
| `security.scan.completed` | Security | AI, Dashboard |
| `security.finding.opened` | Security | Audit, Notifications |
| `security.finding.resolved` | Security | Audit |
| `compliance.report.generated` | Compliance | Audit, Dashboard |
| `ai.analysis.completed` | AI | Dashboard |
| `ai.pattern.learned` | AI | (internal) |

### Event envelope

```ts
interface DomainEvent<T> {
  id: string;             // UUIDv7 — time-sortable
  type: string;           // 'iam.session.opened'
  occurredAt: string;     // ISO 8601 UTC
  context: string;        // 'iam'
  aggregateType: string;  // 'session'
  aggregateId: string;
  actor?: { userId?: string; serviceAccountId?: string; system?: true };
  payload: T;             // typed per event
  correlationId?: string;
  causationId?: string;
  schemaVersion: number;
}
```

### Bus

- In-process **EventBus** (`src/shared/events/`) with typed subscribe/publish.
- Subscribers are registered at app startup; failures are logged but do not
  crash the publisher.
- For the future broker, the same envelope is serialised as JSON; topics
  follow the type name.

### Persistence

- Audit subscriber persists every event into `auditLogs` (ADR-0017) and a
  dedicated `securityEvents` collection (queryable by severity, type).
- Optional outbox pattern: write events transactionally with the producing
  aggregate's state change, drained by a dispatcher to the bus.

### Positive Consequences

- Domain events become explicit, typed, testable.
- Subscribers can be added without modifying producers.
- Smooth path to broker-backed eventing.

### Negative Consequences / Trade-offs

- Versioning discipline required (additive only; never repurpose a name).
- In-process bus is single-pod; cross-pod fan-out arrives with the broker.

## References

- `src/types/auth.types.ts:SecurityEventType`
- ADR-0017 (audit logging)
- DDD-12 (cross-context events)
