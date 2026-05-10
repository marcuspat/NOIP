# ADR-0011: AgentDB and ReasoningBank adapter pattern for AI memory

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** ai, architecture

## Context

Plain prompt-and-response calls to an LLM lose value across sessions —
NOIP would re-discover the same patterns over and over, and operators
would not see learning over time. We want:

1. **Vector memory** of past analyses so similar inputs surface prior
   findings (e.g. "this drift pattern matches incident #47").
2. **Experience log** of which strategies the AI recommended and how
   they fared, so future recommendations can be weighted.
3. **Provider independence** for both — vector DB and experience log
   should be replaceable without rewriting `AIService`.

The market for vector stores is unsettled (pgvector, Pinecone, Qdrant,
Weaviate, in-memory). Locking in too early is a mistake; doing nothing
is also a mistake.

## Decision

We define two **adapter interfaces** consumed by `AIService`
(`src/services/ai.service.ts`):

- `IAgentDB` — `upsert(vector, payload, metadata)`,
  `query(vector, k, filter?)`, `delete(id)`. Implementations may use
  Pinecone, pgvector, Qdrant, or a no-op.
- `IReasoningBank` — `recordExperience(context, strategy, outcome)`,
  `recommendStrategy(context)`. Implementations may store in MongoDB,
  use a learned policy, or be no-op for tests.

Today both ship with **mock in-process implementations** marked clearly
as such. Production deployments wire in real adapters via `src/config/index.ts`.

`AIService` never references a concrete vector or experience store.

## Alternatives considered

- **Direct integration with one vector DB.** Faster to ship, but
  couples the codebase to a vendor we are not yet ready to commit to.
- **Stuff everything into MongoDB.** Acceptable as a starting point
  (a Mongo-backed `IAgentDB` is on the roadmap), but the abstraction
  is needed regardless to allow swapping.
- **Skip memory entirely.** Loses the differentiating capability.

## Consequences

### Positive
- `AIService` is testable without a vector DB.
- We can ship today with mock memory and upgrade incrementally.
- Vendor selection is a future, isolated decision.

### Negative / costs
- Mocked memory means the AI does not actually learn yet — clearly
  documented in the README so operators do not over-trust it.
- Two more interfaces to keep stable (mitigated: small surface area).

### Risks and mitigations
- *Adapter API drift.* The interfaces are intentionally minimal.
  Adding methods requires an ADR amendment, not just a code change.
- *Hidden coupling.* Code reviews enforce that no other service
  imports `IAgentDB` / `IReasoningBank`.

## References

- `src/services/ai.service.ts` — adapter consumption.
- `src/types/index.ts` — `AIAnalysis`, `AIContext`,
  `AILearningPattern`.
