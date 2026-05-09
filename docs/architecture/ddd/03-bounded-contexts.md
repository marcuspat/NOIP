# DDD-03: Bounded Contexts Overview

NOIP comprises **seven** bounded contexts. Each owns its own model, ubiquitous
language, persistence, and (eventually) deployment. This document gives the
intent, scope, and boundaries; tactical design is in the per-context
documents (DDD-05 through DDD-11).

## Summary

| # | Bounded Context | Type | Owns | Source-tree home |
|---|-----------------|------|------|------------------|
| 1 | **Identity & Access Management** | Generic | Users, roles, permissions, sessions, MFA, SSO, API keys, service accounts | `src/contexts/iam/` |
| 2 | **Infrastructure Discovery** | Core | Clusters, resource snapshots, namespaces, nodes, drift detection | `src/contexts/discovery/` |
| 3 | **Security & Compliance** | Core | Security scans, findings, policies, compliance frameworks, reports | `src/contexts/security/` |
| 4 | **AI Analysis** | Core | Analyses, learning patterns, RAG contexts | `src/contexts/ai/` |
| 5 | **Performance** | Supporting | Probes, load tests, SLOs, budgets | `src/contexts/performance/` |
| 6 | **Dashboard & Reporting** | Supporting | Dashboards, widgets, exports | `src/contexts/dashboard/` |
| 7 | **Audit & Observability** | Generic | Audit logs, security events, metric/trace plumbing | `src/contexts/audit/` |

(Source-tree paths are the **target** layout per ADR-0011; the current code
under `src/services/`, `src/models/` etc. maps onto these as listed in each
context document.)

## Boundaries — what lives where

The boundary tests below help disambiguate which context owns a piece of
behaviour.

### "Who owns the User?"

- **Identity** — IAM owns the canonical `User` aggregate.
- Other contexts hold **references by ID** and project minimal user data
  (e.g. dashboards display `firstName + lastName`, joined through IAM's read
  API).

### "Who owns a Kubernetes pod's record?"

- **Discovery** owns the inventory snapshot of the pod.
- **Security** owns *findings against* the pod, holding only the pod's
  cluster-qualified ID.
- **AI** holds neither; it *receives* both via application-service calls or
  events.

### "Who owns an audit record?"

- **Audit** owns the `AuditLog` collection. Producers emit domain events,
  Audit subscribes and persists.

### "Who owns a security event?"

- **IAM**, **Discovery**, **Security**, etc. *publish* events.
- **Audit** *consumes* and persists them.
- The *event types* are defined in a shared kernel (DDD-12) so producers and
  consumers agree.

## Context Boundaries Rule

A bounded context is defined by:

1. **Its model** — a coherent set of aggregates, entities, value objects.
2. **Its ubiquitous language** — a glossary that is internally consistent.
3. **Its persistence** — own collections / databases.
4. **Its public surface** — a single barrel module (`api/index.ts`) and a
   set of published events.

Crossing a context boundary requires either:

- An application-service call through the target's `api/` barrel, **or**
- A subscription to the target's domain events, **or**
- Use of a Shared Kernel artefact (IDs, time types, event envelopes).

Crossing in any other way (importing another context's model, reading its
collections directly) is a **defect** that lint rules (ADR-0022) must catch.

## Per-context summaries

### 1. Identity & Access Management (IAM)

**Purpose:** Authenticate every actor and authorise every request.
**Critical invariants:**

- A user with `status != 'active'` cannot log in (except `pending_verification`
  paths).
- A locked user cannot authenticate until `lockedUntil` passes.
- A revoked refresh token cannot be exchanged.
- MFA-required policies cannot be bypassed.

Detail: [05](./05-context-iam.md).

### 2. Infrastructure Discovery

**Purpose:** Maintain an accurate, time-stamped inventory of observed
infrastructure.
**Critical invariants:**

- Snapshots are immutable.
- Drift is computed only against the previous snapshot for the same scope.

Detail: [06](./06-context-infrastructure-discovery.md).

### 3. Security & Compliance

**Purpose:** Evaluate inventory and policies to produce findings, scores, and
compliance evidence.
**Critical invariants:**

- A finding always references the inventory snapshot and policy version that
  produced it.
- Compliance reports are derived; never edited directly.

Detail: [07](./07-context-security-compliance.md).

### 4. AI Analysis

**Purpose:** Produce ground, citable analyses and predictions using Claude
and RAG.
**Critical invariants:**

- Every `AIAnalysisResult` records the strategy and retrieved context IDs.
- Sensitive data is redacted at the ACL boundary; inputs to Claude carry no
  secrets.

Detail: [08](./08-context-ai-analysis.md).

### 5. Performance

**Purpose:** Self-monitor latency / throughput, run synthetic and load
checks, track SLOs.
**Critical invariants:**

- A probe records both raw measurements and the SLO it tested against.

Detail: [09](./09-context-performance.md).

### 6. Dashboard & Reporting

**Purpose:** Compose widgets backed by other contexts' read APIs.
**Critical invariants:**

- Widgets are pure read views; mutations must round-trip through the owning
  context.

Detail: [10](./10-context-dashboard.md).

### 7. Audit & Observability

**Purpose:** Tamper-evident record of all actor → resource interactions and
infrastructure for metrics/logs/traces.
**Critical invariants:**

- Audit logs are append-only.
- Hash chain is unbroken.

Detail: [11](./11-context-audit-observability.md).
