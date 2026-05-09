# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, Architecture Working Group
- **Tags:** governance, documentation

## Context and Problem Statement

NOIP is a multi-domain platform (infrastructure discovery, security/compliance,
AI analysis, dashboards) that integrates several non-trivial technologies
(Kubernetes, MongoDB, Redis, Anthropic Claude, RAG/ChromaDB, JWT/MFA, etc.).
Without a written record of *why* foundational choices were made, future
contributors will reverse-engineer rationale from code, repeat closed
discussions, or — worse — silently drift from agreed designs.

## Decision Drivers

- Decisions must outlive their authors and PR threads.
- Onboarding should not require tribal knowledge.
- Superseding a decision should be an explicit, traceable act.
- The format must be lightweight enough that the team will actually use it.

## Considered Options

1. **MADR (Markdown Any Decision Records)** — well-known, lightweight, supports
   superseding workflow.
2. **Nygard ADR** — the original short-form ADR format.
3. **Wiki page per decision** — free-form, no template.
4. **No formal ADR process** — rely on PR descriptions and code comments.

## Decision Outcome

**Chosen option:** MADR-lite (Status / Context / Drivers / Options / Outcome /
Consequences), stored in `docs/architecture/adr/` as numbered Markdown files.

### Positive Consequences

- Decisions are versioned alongside the code in Git.
- Consistent template lowers writing friction.
- Numbering and the `Superseded by` field make change history explicit.

### Negative Consequences / Trade-offs

- Modest authoring overhead per significant decision.
- Risk of drift if ADRs are not kept in sync with reality — mitigated by
  reviewing the ADR index in quarterly architecture reviews.

## Pros and Cons of the Options

### MADR-lite

- 👍 Industry-standard sections, broadly tooled.
- 👍 Light enough to write in 30 minutes.
- 👎 Slight overhead vs. plain wiki.

### Nygard ADR

- 👍 Even lighter.
- 👎 No "decision drivers" or "considered options" sections, which we have
  found valuable in retrospectives.

### Wiki

- 👍 Zero structure.
- 👎 Decays fast; not versioned with code.

### No process

- 👍 Zero overhead.
- 👎 Information loss is the *failure mode* this ADR exists to prevent.

## References

- [MADR](https://adr.github.io/madr/)
- Michael Nygard, *Documenting Architecture Decisions* (2011)
- ThoughtWorks Tech Radar — *Lightweight ADRs* (Adopt)
