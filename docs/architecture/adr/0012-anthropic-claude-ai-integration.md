# ADR-0012: Anthropic Claude as the AI analysis provider

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** AI/ML, Platform engineering
- **Tags:** ai, integration

## Context and Problem Statement

NOIP needs natural-language analysis of infrastructure data: comprehensive
posture reviews, security investigations, performance recommendations, and
executive summaries. The READme, configuration (`AI_API_KEY`,
`AI_ENDPOINT=https://api.anthropic.com`), and Python script
(`scripts/ai_analysis.py`) make Anthropic Claude the de-facto provider.

## Decision Drivers

- High-quality reasoning over long, structured infrastructure inventories.
- Long context windows for whole-cluster snapshots and prior reports
  (RAG-augmented).
- Tool-use and structured-output capability for analysis pipelines.
- Predictable enterprise terms (Anthropic API).

## Considered Options

1. **Anthropic Claude (Opus / Sonnet / Haiku tiers).**
2. **OpenAI GPT-4o family.**
3. **Open-source local models (Llama 3.x, Mixtral) via Ollama / vLLM.**
4. **Multi-provider abstraction.**

## Decision Outcome

**Chosen option:** **Anthropic Claude** as the primary provider with a thin
**provider abstraction** in `src/services/ai.service.ts` that allows future
multi-provider routing without changing application services.

### Model tiering

| Use case | Model tier | Rationale |
|----------|-----------|-----------|
| Comprehensive analysis (`AIAnalysisRequest.type = 'security' \| 'compliance'`) | Opus (latest) | Best reasoning quality. |
| Performance / cost analysis | Sonnet | Fast, strong reasoning. |
| Summarisation, formatting | Haiku | Cheapest, lowest latency. |

We default to the **latest Opus / Sonnet / Haiku** identifiers when building
new flows (per current Claude model family). Model identifiers are
configuration-driven (`AI_MODEL_*` env vars) so they can be rotated without
code changes.

### Integration shape

- All Claude calls go through an **AnthropicAdapter** (anti-corruption layer,
  DDD-16) that:
  - applies prompt templates (system / user / tool messages),
  - injects RAG context retrieved from ChromaDB (ADR-0013),
  - applies prompt-caching headers for stable system prompts,
  - retries with exponential backoff on `429` and `5xx`,
  - records token usage and cost metrics.
- The **Application Service** (`AIService.analyzeSecurity`,
  `analyzeCompliance`, etc.) sees only the domain-shaped
  `AIAnalysisRequest` / `AIAnalysisResult` types.
- Sensitive infrastructure data is **redacted** before transmission according
  to the data-classification policy (DDD-08).

### Positive Consequences

- Best-in-class reasoning quality.
- Long context windows allow fewer prompt-engineering tricks.
- Provider abstraction guards against vendor lock-in.

### Negative Consequences / Trade-offs

- Provider dependency, cost per request.
- Network egress to a third party — must be reflected in our data-handling
  posture and customer-facing contracts.

## Pros and Cons of the Options

### Anthropic Claude

- 👍 Strong long-context reasoning; ergonomic API; tool use.
- 👎 Vendor dependency.

### OpenAI

- 👍 Mature ecosystem.
- 👎 Pricing and feature pacing different; we already built around Anthropic.

### Local OSS

- 👍 No data egress.
- 👎 Operational cost; lower quality at our problem complexity today.

### Multi-provider

- 👍 Resilience.
- 👎 Premature; we will keep the abstraction so we can add later.

## References

- `src/services/ai.service.ts`
- `scripts/ai_analysis.py`
- ADR-0013 (RAG)
- DDD-08, DDD-16
