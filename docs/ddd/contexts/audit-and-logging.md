# Bounded Context: Audit & Logging

> *Generic subdomain.* The implementation is standard (Winston +
> Mongo); the *discipline* of getting an audit trail right matters.

## Purpose

Produce a complete, queryable, tamper-evident record of *who did what
to which thing*, plus structured operational logs. Meet auditor
expectations for SOC2 / ISO27001 / HIPAA-grade evidence.

## Ubiquitous language (canonical)

`Audit Event` · `Correlation Id`. See
[`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern              | File                                    |
| -------------------- | --------------------------------------- |
| Middleware           | `src/middleware/audit.middleware.ts`    |
| Logger               | `src/utils/logger.ts`                   |
| Aggregate root       | `AuditEvent` (planned model)            |

`SecurityEvent` (`src/models/security-event.model.ts`) is owned by
**Security Operations**; Audit & Logging consumes it. Audit's own
aggregate is the more general `AuditEvent`.

## Aggregates

### AuditEvent (planned)
- **Root**: `AuditEvent`.
- **Identity**: `AuditEventId` (UUIDv7).
- **Fields**:
  - `correlationId`
  - `actor: { kind: 'user' | 'system' | 'service', id?: string,
    sessionId?: string }`
  - `action: string` (verb-noun, e.g. `assess.start`,
    `cluster.register`, `session.revoke`)
  - `targetKind`, `targetId`
  - `outcome: success | failure`
  - `request: { method, path, ip, userAgent, status, latencyMs }`
  - `before?`, `after?` — diffable snapshots for state changes
  - `errorClass?` — when outcome is failure
  - `occurredAt`
- **Invariants**:
  1. Immutable; corrections are new events that reference the
     original `AuditEventId`.
  2. `actor.kind === 'user'` ⇒ `actor.id` is present.
  3. `outcome === 'failure'` ⇒ `errorClass` is present.
  4. Sensitive fields (`password`, `token`, `mfaSecret`,
     `backupCodes`) are scrubbed by the redactor before persistence.

## Logging vs. auditing — the distinction

| Concern         | Lives in                  | Retention | Mutable | Used for           |
| --------------- | ------------------------- | --------- | ------- | ------------------ |
| **Logs**        | Stdout → log aggregator   | 30–90 d   | No      | Debugging, alerting |
| **Audit Events**| MongoDB                   | Years     | No      | Compliance, forensics |
| **Security Events** | MongoDB              | Years     | Lifecycle only (resolution) | Triage |

Every audit event also produces a log line with the same
`correlationId`, but logs may be sampled and audit events may not.

## Middleware behaviour

`audit.middleware.ts`:

1. On request: read or generate `X-Correlation-Id`, set in
   `AsyncLocalStorage`, set on the response.
2. Wrap the handler: capture HTTP method, path, status, latency.
3. On response: if the route is configured as auditable (most are),
   write an `AuditEvent` with the request fingerprint.
4. Failures (5xx) always audit, even on otherwise non-audited
   routes.

The middleware never writes secrets. The logger and the audit writer
share a single `redact()` function.

## Domain service

`AuditService` (planned) exposes:

- `record(event: AuditEventInput)` — used by services that want to
  emit a structured audit entry beyond what the middleware captures
  (e.g. background jobs).
- `query(filters)` — paginated, indexed by `correlationId`,
  `actor.id`, `action`, `targetId`, time range.
- `export(filters, format)` — for auditor handoff.

## Domain events

Audit & Logging is a *subscriber*, not a publisher. It listens to
every domain event in the catalogue
([`../domain-events.md`](../domain-events.md)) and writes
`AuditEvent` records as appropriate.

## Storage

- **MongoDB collection** with TTL = audit retention (years, not
  days). Sharded by month if volumes warrant it.
- Indexes:
  - `(occurredAt desc)` — primary timeline index.
  - `(actor.id, occurredAt desc)` — per-user audit.
  - `(correlationId)` — request reconstruction.
  - `(action, occurredAt desc)` — by-action queries.
  - `(targetKind, targetId, occurredAt desc)` — per-target history.

## Integration with neighbouring contexts

- **Every** context emits domain events that Audit subscribes to.
- **Compliance & Risk** queries audit data as evidence for
  monitoring controls.
- **Dashboard & Reporting** displays a per-target audit trail panel.
- Logs are shipped via stdout to the cluster log aggregator (Loki /
  Elastic); NOIP does not host its own log store beyond the audit
  collection.

## Tamper-evidence (planned)

For high-grade environments, the `AuditEvent` collection can be
configured for append-only mode with periodic Merkle-tree hashing
exported to a secondary store. Today's deployment relies on
storage-level access control (Mongo RBAC, K8s RBAC) plus the
service-level rule that audits are immutable.

## Out of scope (deliberately)

- A full SIEM. We export to one; we don't reimplement one.
- Log search UI in NOIP itself. Operators use their existing log
  tooling.
- Real-time audit-event streaming to customers. Pull-based query is
  the primary access pattern today.

## Open questions

- The exact verb taxonomy for `AuditEvent.action` — should it be
  free-form within rules, or a closed enum? Today: enum
  (`<context>.<verb>`); maintained alongside the domain-events
  catalogue.
- Whether to colocate `SecurityEvent` and `AuditEvent` in one
  collection. Today: separate. Their lifecycles differ.
