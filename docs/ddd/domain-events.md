# Domain Events

Domain events are the explicit "something meaningful happened" signals
that travel between bounded contexts. They are part of the design,
not an implementation detail to retrofit.

This document records the events NOIP publishes today (or plans to
publish), who emits them, who listens, and what payload they carry.

## Conventions

- **Names** are past-tense, in PascalCase, namespaced by their
  emitting context: `iam.UserRegistered`, `discovery.SnapshotCompleted`,
  `secops.FindingRaised`, `compliance.AssessmentCompleted`,
  `ai.AnalysisProduced`.
- **Payloads** carry the aggregate id and *only* the data that is
  immutable at the time of the event. Subscribers needing more
  request it via the emitter's read API.
- **Emission** happens after the aggregate is persisted, in the same
  service call. Today this is an in-process `EventEmitter`; the
  contract is shaped so it can move to a message bus without
  consumer changes.
- **Idempotency**: every event carries an `eventId` (UUIDv7) and an
  `occurredAt` timestamp. Subscribers must dedupe on `eventId`.

## Catalogue

### Identity & Access

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `iam.UserRegistered`             | `userId`, `email`, `roles[]`                          | Audit, Dashboard               |
| `iam.UserLoggedIn`               | `userId`, `sessionId`, `ip`, `deviceFingerprint`      | Audit, SecOps                  |
| `iam.UserLoginFailed`            | `email`, `ip`, `reason`                               | Audit, SecOps                  |
| `iam.MfaEnrolled`                | `userId`, `channel`                                   | Audit, Compliance              |
| `iam.MfaChallengeFailed`         | `userId`, `channel`, `ip`                             | Audit, SecOps                  |
| `iam.SessionRevoked`             | `userId`, `sessionId`, `reason`                       | Audit, Dashboard               |
| `iam.PasswordChanged`            | `userId`                                              | Audit, SecOps                  |
| `iam.RoleAssigned`               | `userId`, `roleId`, `byUserId`                        | Audit, Compliance              |

### Infrastructure Discovery

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `discovery.ClusterRegistered`    | `clusterId`, `name`, `endpoint`                       | Audit, Compliance              |
| `discovery.ScanStarted`          | `clusterId`, `runId`                                  | Dashboard, Performance         |
| `discovery.SnapshotCompleted`    | `clusterId`, `runId`, `resourceCount`                 | SecOps, Compliance, AI, Dashboard |
| `discovery.DriftDetected`        | `clusterId`, `driftId`, `severity`, `resourceCount`   | SecOps, AI, Dashboard          |
| `discovery.ScanFailed`           | `clusterId`, `runId`, `errorClass`                    | SecOps, Dashboard, Performance |

### Security Operations

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `secops.FindingRaised`           | `findingId`, `type`, `severity`, `clusterId?`         | Audit, Compliance, AI, Dashboard |
| `secops.FindingAcknowledged`     | `findingId`, `byUserId`                               | Audit, Dashboard               |
| `secops.FindingResolved`         | `findingId`, `byUserId`, `resolution`                 | Audit, Compliance, Dashboard   |
| `secops.FindingSuppressed`       | `findingId`, `byUserId`, `reason`                     | Audit, Compliance              |
| `secops.IncidentEscalated`       | `findingId`, `severity`                               | Dashboard, AI                  |

### AI Intelligence

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `ai.AnalysisProduced`            | `analysisId`, `targetKind`, `targetId`, `confidence`  | Dashboard, Compliance          |
| `ai.RecommendationAccepted`      | `analysisId`, `recommendationId`, `byUserId`          | Audit, ReasoningBank           |
| `ai.RecommendationRejected`      | `analysisId`, `recommendationId`, `reason`            | Audit, ReasoningBank           |
| `ai.PatternLearned`              | `patternId`, `dimensionality`                         | Dashboard                      |

### Compliance & Risk

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `compliance.AssessmentStarted`   | `assessmentId`, `framework`                          | Audit, Performance             |
| `compliance.AssessmentCompleted` | `assessmentId`, `framework`, `score`, `failedCount`  | Audit, Dashboard, AI           |
| `compliance.EvidenceAttached`    | `controlId`, `evidenceId`                            | Audit                          |
| `compliance.ControlFailed`       | `controlId`, `assessmentId`, `severity`              | SecOps, AI, Dashboard          |

### Performance & Observability

| Event                            | Payload                                              | Subscribed by                  |
| -------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `perf.LoadTestCompleted`         | `testId`, `throughput`, `p99LatencyMs`, `errorRate`   | Dashboard                      |
| `perf.ThresholdBreached`         | `metric`, `value`, `threshold`                       | SecOps (if security-relevant), Dashboard |

### Audit & Logging

The Audit context is *purely a subscriber* in the catalogue above —
it does not emit domain events of its own. Its outputs are durable
`AuditEvent` records and structured log lines.

## Implementation today

- An in-process `EventBus` lives in `src/utils/event-bus.ts`
  (planned). Contexts inject it via constructor.
- Synchronous handlers run in the request lifecycle (e.g. Audit
  writing the trail).
- Asynchronous handlers (e.g. AI consuming a `SnapshotCompleted` to
  prepare an analysis) run in a queued worker; failures retry with
  backoff and dead-letter into a `failed_events` collection.

## Implementation tomorrow

When the modular monolith is split, this catalogue becomes the
contract for a real message bus (likely NATS or Redis Streams given
existing infra). No payload changes; transport changes.

## Reviewer checklist

- [ ] Is the event past-tense?
- [ ] Is it namespaced by emitting context?
- [ ] Does the payload carry only stable, point-in-time data?
- [ ] Is `eventId` and `occurredAt` populated?
- [ ] Is emission *after* persistence in the same operation?
- [ ] Are subscribers explicitly listed in this document?
