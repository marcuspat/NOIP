# Bounded Context: Compliance & Risk

> *Supporting subdomain.* High customer value, but the differentiation
> lies in leveraging core data (Discovery + SecOps), not in the
> compliance-mapping itself.

## Purpose

Map evidence collected by NOIP (snapshots, findings, audit events,
attestations) to the controls of multiple compliance frameworks, run
assessments, and produce auditor-ready reports.

## Ubiquitous language (canonical)

`Framework` · `Compliance Control` · `Evidence` · `Assessment` ·
`Compliance Score`. See
[`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern         | File                                         |
| --------------- | -------------------------------------------- |
| Domain service  | `src/services/compliance.service.ts`         |
| HTTP controller | `src/controllers/compliance.controller.ts`   |
| HTTP routes     | `src/routes/compliance.routes.ts`            |

Aggregate models for `ComplianceControl`, `Framework`, `Evidence`,
`Assessment` are **planned**; today the service operates on in-memory
fixtures. Shapes below are the contract.

## Aggregates

### ComplianceControl
- **Root**: `ComplianceControl`.
- **Identity**: `ControlId` (NOIP-generic, framework-agnostic).
- **Fields**: `title`, `description`, `severity`,
  `evidenceRequirements[]: { kind, freshnessWindow }`.
- **Invariants**:
  1. `id` stable across releases (referenced by `Framework` mappings).
  2. `severity` is set; defaults to `medium`.

### Framework
- **Root**: `Framework`.
- **Identity**: `FrameworkId` (`SOC2`, `ISO27001`, `GDPR`,
  `HIPAA`, `PCI_DSS`).
- **Fields**: `name`, `version`, `mappings[]:
  { externalId, controlId }` — links external control identifiers
  (e.g. `SOC2-CC6.1`) to NOIP `ControlId`s.
- **Invariants**:
  1. Each `externalId` maps to at most one `ControlId`; many-to-one
     is allowed in the other direction.
  2. `version` change is a new `Framework` aggregate, not a mutation.

### Evidence
- **Root**: `Evidence`.
- **Identity**: `EvidenceId`.
- **Fields**: `kind: scan | snapshot | attestation | configuration |
  policy_doc`, `controlIds[]` (one piece of evidence may satisfy
  multiple controls), `producedAt`, `expiresAt?`,
  `sourceRef` (e.g. snapshotId, findingId, S3 url).
- **Invariants**:
  1. Immutable; updates produce a new `Evidence` aggregate.
  2. `expiresAt > producedAt` when set.

### Assessment
- **Root**: `Assessment`.
- **Identity**: `AssessmentId`.
- **References**: `frameworkId`, `tenantId?`.
- **Fields**: `startedAt`, `completedAt?`, `controlResults[]:
  { controlId, status: pass | partial | fail, evidenceIds[],
  notes? }`, `score: 0..100`.
- **Invariants**:
  1. Once `completedAt` is set, the aggregate is **immutable**.
  2. `score` is computed deterministically from `controlResults`
     using the framework's weighting (default: equal weight, severity-
     adjusted).
  3. A control marked `pass` references at least one non-expired
     `Evidence`.

## Value objects

- `ComplianceScore` — `{ value: number, breakdown: { pass: n,
  partial: n, fail: n } }`.
- `EvidenceRequirement` — `{ kind: EvidenceKind, freshnessWindow:
  Duration }`.
- `ControlResult` — see Assessment fields.

## Domain service

`ComplianceService`:

- `runAssessment(frameworkId, tenantId?)` → builds an `Assessment`,
  iterates the framework's controls, gathers evidence (cross-context
  reads), evaluates pass/partial/fail, persists, emits
  `compliance.AssessmentStarted` and (on completion)
  `compliance.AssessmentCompleted`.
- `attachEvidence(controlId, evidenceInput)` →
  `compliance.EvidenceAttached`.
- `getReport(assessmentId, format: json | csv | pdf)` — renders
  framework-specific layout from generic data.
- `listFrameworks()`, `getFramework(id)`.
- `dashboard(frameworkId?)` — current score + trend across recent
  assessments.

## Cross-context reads (no cross-context writes)

Controls draw evidence from:

- **Discovery**: latest `Snapshot`, drift history.
- **Security Operations**: open/resolved `Finding` counts by severity.
- **Identity & Access**: MFA-enrolment proportion, password-policy
  conformance, recent privileged-access changes.
- **Audit & Logging**: audit completeness signals (e.g. is logging
  enabled for the in-scope namespaces).

Each read goes through the neighbouring context's service interface.
Compliance never touches another context's MongoDB collection
directly.

## Domain events

`compliance.AssessmentStarted`, `compliance.AssessmentCompleted`,
`compliance.EvidenceAttached`, `compliance.ControlFailed`. See
[`../domain-events.md`](../domain-events.md).

## Conformist relationship to external frameworks

Compliance is *Conformist* relative to the frameworks themselves —
SOC2 control identifiers, ISO27001 clause numbers, GDPR articles
must be reproduced verbatim in the rendered report. We don't try to
"renegotiate" the framework's vocabulary; we map it.

The mapping is a deliberate, reviewable artefact in
`Framework.mappings`. Adding a new framework version is a data
migration, not a code change.

## Reporting

Reports are *rendered views* over the agnostic `Assessment` data:

- **JSON** — canonical shape; consumed by Dashboard.
- **CSV** — flat per-control row; for spreadsheet ingestion.
- **PDF** — auditor-targeted, framework-specific layout (templates
  in `src/services/compliance/templates/`, planned).

## Out of scope (deliberately)

- Compliance **workflows** (control owner assignment, due dates,
  remediation tracking). Today's model is read-mostly; a future
  workflow context would consume these aggregates.
- **Continuous control monitoring** (live alerting on a control
  going from pass→fail). Today we run point-in-time assessments;
  continuous monitoring is a roadmap item.
- **Multi-jurisdictional GDPR analysis** (data residency proofs).

## Open questions

- Per-control weighting scheme — equal vs. severity-weighted vs.
  framework-defined — needs a product decision before v1 reports go
  out.
- Whether expired evidence should drop a control to `partial` or
  `fail`. Today: `partial`; this is conservative.
