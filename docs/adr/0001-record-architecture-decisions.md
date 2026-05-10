# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** Platform engineering
- **Tags:** process, documentation

## Context

NOIP has accumulated a number of significant architectural choices — JWT-based
auth, MongoDB + Redis split, Argon2id, Anthropic Claude as the AI provider,
RBAC with conditional permissions, etc. — but none of them are documented in a
way that survives rewrites of the README. New contributors have to reverse-
engineer the rationale from code, and old contributors forget what trade-offs
they accepted.

We need a lightweight, durable record of decisions, kept in version control
beside the code so it travels with the project and gets reviewed alongside
related changes.

## Decision

We adopt **Architecture Decision Records (ADRs)** in the style of Michael
Nygard's "Documenting Architecture Decisions". ADRs live in `docs/adr/`, are
numbered sequentially, are written in Markdown, and follow the template at
`docs/adr/template.md`. ADRs are immutable once accepted; replacing a decision
is done by writing a new ADR that supersedes the old one.

## Alternatives considered

- **Wiki / Confluence** — discoverability poor, decoupled from the code, not
  reviewed in PRs, prone to bit-rot.
- **One central `ARCHITECTURE.md`** — works for very small projects but turns
  into an unmaintainable narrative as decisions accumulate.
- **No formal record** — the status quo. Loses the "why".

## Consequences

### Positive
- Decision rationale is discoverable, reviewable, and versioned.
- New decisions get the same level of scrutiny as code (PR review).
- ADR numbers can be cited from code comments and PR descriptions.

### Negative / costs
- Small ongoing authoring overhead for non-trivial decisions.
- Risk that ADRs become stale if not maintained — mitigated by the "supersede,
  do not edit" rule.

### Risks and mitigations
- *Authors writing essays.* The template is intentionally short; keep ADRs to
  one page where possible.

## References

- Michael Nygard, "Documenting Architecture Decisions" (2011).
- ThoughtWorks Tech Radar entry on ADRs.
