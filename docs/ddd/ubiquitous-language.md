# Ubiquitous Language

Words in this glossary have a **precise meaning in NOIP**. Use them in
code (class names, methods, log fields, event names), in
conversations, in tickets, in PR titles, and in customer
communications. If reality has shifted away from the glossary, update
the glossary in the same PR — do not silently drift.

Each entry shows: the term, the bounded context that owns its
canonical definition, and the meaning. Where two contexts use the same
word with different meanings, both entries are listed and the
difference is called out.

---

## Identity & Access

- **User** — A person who can log in to NOIP. Has zero or more `Role`s
  and a credential (password) plus optional MFA enrolment. Source of
  truth: `src/models/user.model.ts`.
- **Role** — A named bundle of `Permission`s. May inherit from a
  parent role. Source: `src/models/role.model.ts`.
- **Permission** — A `(resource, action, conditions?)` tuple.
  Conditions are evaluated against the request context.
  See [ADR-0009](../adr/0009-rbac-with-conditional-permissions.md).
- **Session** — A live login. Tracked in MongoDB
  (`session.model.ts`) and mirrored in Redis with TTL = refresh-
  token lifetime. Has a device fingerprint and an optional geo-
  location.
- **Access Token** — Short-lived JWT (15 min) carrying identity and
  permission summary.
- **Refresh Token** — Long-lived JWT (7 d) used to mint new access
  tokens. **Rotated** on every use.
- **MFA Channel** — One of `TOTP | SMS | EMAIL`. A user may enrol
  multiple; one is the **default**.
- **Backup Code** — A single-use recovery code, hashed at rest. 10
  per user.
- **Device Fingerprint** — A stable hash of user-agent + IP + a few
  passive signals; not a guarantee of identity, used for risk
  scoring.

## Infrastructure Discovery

- **Cluster** — A discoverable Kubernetes cluster. Has a name,
  endpoint, credentials reference, and last-scan timestamp.
- **Namespace** — Kubernetes namespace within a cluster.
- **Resource** — A discovered Kubernetes API object (Deployment, Pod,
  Service, ConfigMap, …). Belongs to a `Namespace` and a `Cluster`.
- **Discovery Run** — A point-in-time enumeration of a cluster.
  Produces a snapshot.
- **Snapshot** — Immutable record of `Resource`s observed during a
  `Discovery Run`. Drift is computed by diffing snapshots.
- **Drift** — A change between two consecutive snapshots that was not
  declared by the desired state. Categorised by severity.

## Security Operations

- **Security Event** — An auditable, security-relevant occurrence.
  Source: `src/models/security-event.model.ts`. Distinguished from a
  generic log line by having a `severity`, `type`, and a resolution
  lifecycle.
- **Severity** — One of `info | low | medium | high | critical`.
- **Finding** — A specific issue detected by a scan. May result in
  one or more `Security Event`s.
- **Secret (finding)** — A high-entropy string in a place it should
  not be (env var, ConfigMap, code).
- **Vulnerability** — A CVE-class issue in an image or library.
- **Integrity Violation** — A monitored file or config that has
  changed without a corresponding declared change.
- **Resolution** — The lifecycle state of a `Security Event`:
  `open | acknowledged | resolved | suppressed`.

## AI Intelligence

- **AI Analysis** — A single response from the AI provider for a
  given input. Has a `confidence`, `summary`, and `recommendations`.
- **Context (AI)** — The input bundle the AI sees: facts, recent
  events, redacted snapshots, related prior analyses.
- **Pattern** — A recurring shape in the data, surfaced via vector
  similarity (`AgentDB`).
- **Strategy** — A recommended course of action; recorded with its
  outcome in `ReasoningBank`.
- **AgentDB** — The vector-memory adapter. See
  [ADR-0011](../adr/0011-agentdb-and-reasoningbank-adapter-pattern.md).
- **ReasoningBank** — The experience-log adapter.

## Compliance & Risk

- **Framework** — A named compliance regime: `SOC2`, `ISO27001`,
  `GDPR`, `HIPAA`, `PCI_DSS`.
- **Compliance Control** — A generic, framework-agnostic control
  definition. Multiple framework controls may map to one compliance
  control.
- **Evidence** — A piece of proof that a control is satisfied.
  Examples: scan result, attestation, configuration snapshot.
- **Assessment** — A point-in-time evaluation of a `Framework`'s
  controls against the current evidence base. Produces a
  `Compliance Score`.
- **Compliance Score** — Numeric (0–100) plus a per-control
  `pass | partial | fail`.

## Performance & Observability

- **Load Test** — A synthetic stress run against NOIP. Records
  throughput, latency percentiles, error rate.
- **Metric** — A timestamped numeric measurement (CPU, RAM, request
  rate, queue depth).
- **Performance Report** — Aggregated metrics + load-test results
  over a time window.

## Audit & Logging

- **Audit Event** — A persisted record that *something happened*,
  written by `audit.middleware.ts` and `SecurityEvent` writes. Lives
  in MongoDB; not just a log line.
- **Correlation Id** — A UUIDv7 generated per inbound HTTP request,
  propagated via `AsyncLocalStorage`, written to every log line and
  to the response header.

## Dashboard & Reporting

- **Dashboard** — A composed view of metrics, events, and AI
  summaries.
- **Report** — A point-in-time export, formatted for humans (PDF /
  CSV / JSON).

---

## Cross-context conflicts to be aware of

- **"Resource"** — In *Infrastructure Discovery* it is a Kubernetes
  object. In *Identity & Access* (within `Permission`) it is a
  domain noun (e.g. `cluster`, `compliance.report`). The two are not
  the same and must not be conflated. When ambiguous, qualify
  explicitly: "K8s resource" vs "permission resource".
- **"Event"** — In *Security Operations* it is a `SecurityEvent`
  aggregate with a lifecycle. In *Audit & Logging* it is an audit
  trail entry. In *AI Intelligence* it is one row of context fed to
  the model. Always prefix when ambiguous: `SecurityEvent`,
  `AuditEvent`, `AIContext`.
- **"User"** — Always means a NOIP operator, *not* a Kubernetes user
  or a customer of the customer.
