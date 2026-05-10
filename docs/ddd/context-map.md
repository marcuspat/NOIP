# Context Map

This document records the **relationships** between NOIP's bounded
contexts. It is a strategic-level view; the per-context tactical
details live under [`contexts/`](./contexts/).

## Diagram

```
                                          ┌──────────────────────┐
                                          │  Identity & Access   │
                                          │  (Generic / kernel)  │
                                          └──────────────────────┘
                                                      ▲
                                          shared kernel: UserId,
                                          PermissionCheck (ACL boundary)
                                                      │
        ┌──────────────────────────────┬──────────────┼──────────────┬──────────────────────────────┐
        │                              │              │              │                              │
        ▼                              ▼              ▼              ▼                              ▼
┌──────────────────┐         ┌──────────────────┐  ┌────────┐  ┌──────────────────┐         ┌──────────────────┐
│  Infrastructure  │         │  Security Ops    │  │  Audit │  │  Compliance      │         │  Performance &   │
│  Discovery       │ ──────▶ │  (downstream)    │  │  & Log │  │  & Risk          │         │  Observability   │
│  (upstream/OHS)  │         │                  │  │ (gen.) │  │  (downstream)    │         │  (independent)   │
└──────────────────┘         └──────────────────┘  └────────┘  └──────────────────┘         └──────────────────┘
        │  ACL              ▲           │            ▲              ▲
        │  (K8s API)        │           │            │              │
        ▼                   │           │            │              │
   Kubernetes                publishes events       │              │
                                                     │              │
                              ┌────────────────────────────────────┐
                              │  AI Intelligence (downstream/ACL)  │
                              │  consumes Discovery, SecOps,       │
                              │  Compliance facts; speaks Anthropic│
                              │  (ACL to vendor)                   │
                              └────────────────────────────────────┘
                                                  │
                                                  ▼
                                  ┌────────────────────────────────┐
                                  │  Dashboard & Reporting         │
                                  │  (downstream of everyone)      │
                                  └────────────────────────────────┘
```

Legend:

- **Upstream** publishes data; **Downstream** consumes it. Failure of
  upstream propagates to downstream unless a defence is in place.
- **OHS** = Open Host Service: a stable interface meant for many
  consumers.
- **ACL** = Anti-Corruption Layer: translation in *one direction*.
- **Shared kernel** = jointly owned, slow-changing, dependency-free.

## Relationships

### Identity & Access ↔ everyone else
- **Pattern**: shared kernel + customer/supplier.
- **Shared kernel** (`src/types/auth.types.ts`): `UserId`, role and
  permission *enum* values consumed by other contexts.
- Every other context consumes `requireAuth()` and
  `requirePermission(resource, action)` middleware. They do **not**
  read user/role/permission documents directly.
- Auth changes that affect the wire (e.g. JWT claim shape) are a
  shared-kernel change and require a coordinated update.

### Infrastructure Discovery → downstream
- **Pattern**: Open Host Service (in-process today, ready to be
  HTTP/gRPC).
- **Outputs**: `Cluster`, `Snapshot`, `Drift` records via
  `DiscoveryService`.
- **Consumers**: Security Operations, Compliance & Risk, AI
  Intelligence, Dashboard.
- An ACL inside Discovery isolates Kubernetes' vocabulary from the
  rest of NOIP — `Pod`, `ConfigMap`, etc. become NOIP `Resource`s.

### Security Operations ↔ Discovery and AI
- **Pattern**: downstream of Discovery (consumes snapshots and
  drift); customer of AI (asks AI for triage suggestions).
- Publishes `SecurityEvent` records to MongoDB; consumed by Audit,
  Dashboard, and Compliance.

### AI Intelligence ↔ everyone (downstream + ACL to vendor)
- **Pattern**: downstream consumer of facts; ACL to the Anthropic
  API and to the vector / experience adapters
  ([ADR-0011](../adr/0011-agentdb-and-reasoningbank-adapter-pattern.md)).
- Never sees a Kubernetes object directly; sees Discovery's NOIP-
  shaped abstractions.
- Outputs `AIAnalysis` records consumed by Dashboard.

### Compliance & Risk → Discovery, Security Ops, AI
- **Pattern**: downstream of all three.
- Conformist relative to external compliance frameworks: maps
  external control identifiers (`SOC2-CC6.1`, `ISO-A.9.2.3`) to
  framework-agnostic NOIP controls
  ([ADR-0013](../adr/0013-compliance-framework-agnostic-control-model.md)).

### Performance & Observability ↔ everyone
- **Pattern**: independent supporting context.
- Reads cross-cutting metrics; emits its own load-test events.
- Never reads or writes another context's domain data.

### Audit & Logging ↔ everyone
- **Pattern**: cross-cutting, consumed via middleware.
- Every authenticated request lands an `AuditEvent`. Every
  `SecurityEvent` is also an audit input but carries richer
  semantics (lifecycle, severity).

### Dashboard & Reporting → everyone
- **Pattern**: pure downstream — only reads.
- Aggregates from each context's read API. Does not write to other
  contexts' stores.

## Integration patterns by call site

| From → To                              | Today              | Eventual                |
| -------------------------------------- | ------------------ | ----------------------- |
| Any → Identity & Access                | In-process call    | In-process (kernel)     |
| SecOps, Compliance, AI → Discovery     | In-process call    | HTTP / gRPC             |
| Compliance, Dashboard → SecOps         | In-process call    | HTTP                    |
| AI → SecOps, Discovery, Compliance     | In-process call    | HTTP                    |
| Anything → Anthropic                   | HTTPS via ACL      | unchanged               |
| Discovery → Kubernetes                 | HTTPS via ACL      | unchanged               |

## Failure semantics

- **Identity & Access down → all writes fail closed.** Reads of
  cached JWTs continue until token expiry.
- **Discovery down →** SecOps and Compliance show the last good
  snapshot; UI surfaces a warning.
- **AI Intelligence down →** dashboards omit the AI panel; no other
  feature is degraded.
- **Audit / log sink down →** writes buffer in-memory briefly, then
  the request is rejected for high-severity events (security writes
  must not be silently dropped).
- **Compliance down →** reports unavailable; everything else
  unaffected.

## Deliberate non-relationships

- The dashboard **never** reads MongoDB collections from other
  contexts directly.
- AI Intelligence **never** reads `User` records — it gets the
  identity from the request context, not from the IAM store.
- Security Operations **never** writes to `User` records — account
  lockouts are signalled to Identity & Access via a service call,
  not by mutating the user document.
