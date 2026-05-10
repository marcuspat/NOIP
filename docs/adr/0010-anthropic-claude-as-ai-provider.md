# ADR-0010: Anthropic Claude as the AI provider

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** ai, integration

## Context

NOIP's "AI Intelligence" capability summarises infrastructure scans,
correlates security findings, recommends remediations, and produces
executive-readable reports. The provider must:

1. Be reliable enough for compliance-adjacent reports.
2. Have a strong reputation for safety alignment — we feed it
   security-sensitive context.
3. Offer long context windows (we send full cluster snapshots and event
   logs).
4. Have a stable, well-documented HTTP API.

## Decision

We use **Anthropic Claude** as the primary LLM provider, called via
direct HTTPS to `https://api.anthropic.com` from
`src/services/ai.service.ts`. The default model is configured via the
`ANTHROPIC_MODEL` env var; today we point at the latest production
Sonnet.

The integration is a thin HTTP client — no vendor SDK — to keep the
surface area small and to avoid coupling our codebase to an SDK release
cadence we don't control.

We always send the `anthropic-version` header. We respect Anthropic's
documented retry headers and use exponential backoff with jitter.

## Alternatives considered

- **OpenAI** — comparable quality. Rejected today because Claude's
  long-context and safety story better matches feeding it raw security
  data, and because we run on the Anthropic stack already.
- **Self-hosted open-weights model** — not feasible for the team's ops
  budget; would also undermine the safety guarantees we rely on.
- **Multi-provider abstraction layer** — premature. The internal
  `AIService` already encapsulates the call; switching providers is
  isolated to that file (see [ADR-0011](./0011-agentdb-and-reasoningbank-adapter-pattern.md)).

## Consequences

### Positive
- High-quality summaries; long context fits NOIP's payloads.
- Single, well-documented API; behaviour upgrades with new model
  versions.
- Calling site is centralised — easy to swap, easy to mock.

### Negative / costs
- Vendor dependency; outages affect AI-dependent features.
- Cost scales with prompt size; we cache and truncate aggressively.

### Risks and mitigations
- *Outage of `api.anthropic.com`.* AI features degrade gracefully — the
  rest of NOIP keeps functioning, AI panels show "analysis unavailable".
- *Sensitive data leakage.* We classify what may be sent in the prompt
  and never include secrets; redaction is enforced in `ai.service.ts`.
- *Model upgrade behaviour change.* Pinned model id in env; upgrades go
  through the same review as any code change.

## References

- `src/services/ai.service.ts` — HTTP client, prompt assembly,
  redaction.
- `src/config/index.ts` — `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_BASE_URL`.
- Anthropic API docs (`docs.anthropic.com`).
