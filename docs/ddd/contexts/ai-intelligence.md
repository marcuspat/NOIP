# Bounded Context: AI Intelligence

> *Core subdomain.* Pattern-aware, memory-equipped analysis is the
> capability that distinguishes NOIP from a glorified scanner with an
> LLM call bolted on.

## Purpose

Take inputs from the rest of NOIP (discovery snapshots, drift,
findings, compliance failures) and produce structured analyses,
summaries, and recommendations. Maintain memory across sessions so
analyses improve as patterns recur.

## Ubiquitous language (canonical)

`AI Analysis` · `Context (AI)` · `Pattern` · `Strategy` · `AgentDB` ·
`ReasoningBank`. See
[`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern        | File                                       |
| -------------- | ------------------------------------------ |
| Domain service | `src/services/ai.service.ts`               |
| Types          | `src/types/index.ts` (`AIAnalysis`, `AIContext`, `AILearningPattern`) |
| HTTP           | mounted via `src/app.ts` under `/api/v1/ai/*` |

Aggregate model for `AIAnalysis` is **planned**; today the service
returns a typed value built from the LLM response. The shape below is
the contract.

## Aggregates

### AIAnalysis (planned)
- **Root**: `AIAnalysis`.
- **Identity**: `AnalysisId`.
- **Fields**:
  - `targetKind: snapshot | drift | finding | compliance.assessment`
  - `targetId`
  - `prompt` (redacted, stored for audit)
  - `model` (e.g. `claude-sonnet-…`)
  - `summary` (markdown)
  - `recommendations[]` — `{ id, title, rationale, severity,
    estimatedEffort }`
  - `confidence` (0–1)
  - `producedAt`
  - `relatedAnalyses[]` (vector-similarity neighbours from AgentDB)
- **Invariants**:
  1. Immutable once produced. Re-running on the same target produces
     a *new* `AIAnalysis`.
  2. `prompt` redacts known secret-shaped fields before persistence.

### Recommendation lifecycle
Recommendations are *embedded* in `AIAnalysis`. Their *acceptance/
rejection* is recorded separately by emitting
`ai.RecommendationAccepted` / `ai.RecommendationRejected`. The
ReasoningBank uses these signals to weight future recommendations.

## Adapter ports (Anti-Corruption Layer)

Per [ADR-0011](../../adr/0011-agentdb-and-reasoningbank-adapter-pattern.md):

```ts
interface IAgentDB {
  upsert(vector: number[], payload: unknown, metadata: Record<string, unknown>): Promise<string>;
  query(vector: number[], k: number, filter?: Record<string, unknown>): Promise<Array<{ id: string; score: number; payload: unknown }>>;
  delete(id: string): Promise<void>;
}

interface IReasoningBank {
  recordExperience(context: AIContext, strategy: Strategy, outcome: Outcome): Promise<void>;
  recommendStrategy(context: AIContext): Promise<Strategy[]>;
}

interface ILLMClient {
  complete(prompt: Prompt, opts?: LLMOpts): Promise<LLMResponse>;
}
```

`AIService` only depends on these interfaces. Concrete
implementations live in `src/services/ai/` (planned subfolder):
`anthropic-llm.client.ts`, `mock-agentdb.ts`, `mongo-reasoning-
bank.ts`, etc.

## Domain service

`AIService`:

- `analyseSnapshot(snapshotId)` → `AIAnalysis`. Pulls discovery data,
  redacts, queries AgentDB for similar prior snapshots, sends to
  LLM, parses, persists, emits `ai.AnalysisProduced`.
- `analyseDrift(driftId)` → `AIAnalysis`.
- `analyseFinding(findingId)` → `AIAnalysis`. Includes related
  findings and the user's recent acceptance/rejection history (via
  ReasoningBank).
- `recordOutcome(analysisId, recommendationId, accepted, notes?)` →
  feeds ReasoningBank.
- `summariseExecutive(period)` → high-level rollup analysis for
  dashboards.

## Prompt and redaction

- All prompts pass through `redact()` which strips fields whose key
  matches the secret-shaped allow-list (`password`, `token`,
  `authorization`, `mfaSecret`, `backupCodes`, `*_KEY`,
  `*_SECRET`, …).
- High-cardinality identifiers (UIDs) are hashed before being shown
  to the model so the model cannot exfiltrate them verbatim.
- Prompt size is capped; truncation prefers structured payload over
  free-form context.

## Domain events

`ai.AnalysisProduced`, `ai.RecommendationAccepted`,
`ai.RecommendationRejected`, `ai.PatternLearned`. See
[`../domain-events.md`](../domain-events.md).

## Integration with neighbouring contexts

- **Discovery**, **Security Operations**, **Compliance**: pure
  consumers — AI calls their read APIs, never their stores.
- **Dashboard**: consumes `AIAnalysis` for visualisation.
- **Audit**: every analysis writes an audit entry containing the
  redacted prompt fingerprint and the model id.
- **Anthropic API** (external, via ACL): `ILLMClient`
  implementation in `anthropic-llm.client.ts`.

## Failure modes

- **LLM timeout / 5xx** — retried with exponential backoff and
  jitter; after the budget, the call fails and the panel shows
  "analysis unavailable". No other context is affected.
- **AgentDB unreachable** — analysis proceeds without similar-prior-
  case context; `relatedAnalyses` is empty and the analysis records
  a degraded flag.
- **ReasoningBank unreachable** — analysis proceeds without
  experience-weighting; recommendations are flagged
  `weighting: unavailable`.

## Cost controls

- Per-target dedup window: re-running an analysis on the same
  `(targetKind, targetId)` within `AI_DEDUP_WINDOW_MIN` returns the
  cached `AIAnalysis`.
- Prompt budget per call: configurable max tokens.
- Daily / monthly spend caps configurable in `src/config/index.ts`;
  exceeding the cap downgrades to "summary-only" mode.

## Out of scope (deliberately)

- Auto-execution of recommendations (would require a workflow
  engine and human-in-the-loop policy first).
- Fine-tuning / training. We use the vendor model as-is and learn
  via prompt + ReasoningBank.
- Multi-vendor LLM routing — `ILLMClient` allows it; we don't
  exercise it today.

## Open questions

- Whether to expose `relatedAnalyses` in the API response or only in
  the dashboard.
- Whether `recordOutcome` should require explicit operator action or
  can be inferred from "no follow-up finding within N days".
