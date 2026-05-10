# ADR-0013: Framework-agnostic compliance control model

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** compliance, modeling

## Context

NOIP reports compliance against multiple frameworks: SOC2 (Type II),
ISO27001, GDPR, HIPAA, PCI-DSS. The naive implementation hard-codes
each framework's controls into per-framework code paths. That
approach:

- Duplicates almost-identical logic (most controls are restatements of
  the same underlying check).
- Makes adding a framework a multi-week effort.
- Hides which evidence satisfies which control.

## Decision

We model compliance against a **framework-agnostic core**:

- A `ComplianceControl` is a generic definition: `{ id, title,
  description, severity, evidenceRequirements[] }`.
- A `ComplianceFramework` is a labelled collection of control
  references with framework-specific identifiers
  (`SOC2-CC6.1`, `ISO-A.9.2.3`).
- An `Evidence` document attaches to a `ComplianceControl` and may be
  reused across frameworks. Evidence types include: scan results,
  policy docs, configuration snapshots, attestations.
- An `Assessment` evaluates a framework against a moment in time and
  produces a per-control `pass | fail | partial` plus an overall score.

`ComplianceService` (`src/services/compliance.service.ts`) operates
on the agnostic model; framework-specific renderers translate to the
auditor-facing report.

## Alternatives considered

- **Per-framework controllers/services.** Faster to ship one
  framework, much slower to add the second.
- **Buy a third-party GRC.** Considered for a separate ADR; the
  in-platform model is what feeds the GRC if/when we adopt one.
- **Hard-code all frameworks now.** Rejected for the duplication
  reasons above.

## Consequences

### Positive
- Adding a new framework is a data-only change in most cases.
- Evidence is reused — one piece of proof can satisfy
  `SOC2-CC6.1` *and* `ISO-A.9.2.3`.
- Auditors see the same underlying evidence regardless of which report
  they read.

### Negative / costs
- The mapping table from framework controls to NOIP's generic
  controls must be maintained.
- Some framework-specific nuance may not fit; we accept a small
  framework-specific extension layer where it does not.

### Risks and mitigations
- *Auditor mismatch.* Reports are reviewed by domain experts before
  being shipped to a customer or auditor.
- *Evidence over-reuse.* Each piece of evidence has a freshness window;
  stale evidence drops to "partial" automatically.

## References

- `src/services/compliance.service.ts`
- `src/controllers/compliance.controller.ts`
- `docs/ddd/contexts/compliance-and-risk.md`
