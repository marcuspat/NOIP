# ADR-0013: RAG knowledge base on ChromaDB

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** AI/ML
- **Tags:** ai, retrieval, persistence

## Context and Problem Statement

Claude analysis quality improves dramatically when prompts are augmented with
prior, *context-specific* findings: previous incidents on the same cluster,
historical compliance gaps, recurring drift events. We need a retrieval layer
that returns the most relevant prior context for each analysis request.

The repository already references this (`docs/PYTHON_RAG_DASHBOARD_PLAN.md`,
`scripts/update_rag.py`) and documents a `rag/` directory with embeddings and
vectors.

## Decision Drivers

- Open-source, can run on-prem if needed.
- Simple persistent vector store with metadata filtering.
- Python-native (matches `scripts/`).
- Easy embedding-model swap.

## Considered Options

1. **ChromaDB**, persisted on disk / PVC.
2. **pgvector** on PostgreSQL.
3. **Pinecone / Weaviate / Qdrant Cloud.**
4. **No RAG; rely on long context only.**

## Decision Outcome

**Chosen option:** **ChromaDB** for the RAG store, with embeddings produced
by a configurable model (default: `voyage-3` via Anthropic-recommended
embedding pipeline; `sentence-transformers/all-MiniLM-L6-v2` in low-cost
mode).

### Collections

| Collection | Documents | Metadata filters |
|------------|-----------|------------------|
| `noip_incidents` | past incident reports | `cluster`, `severity`, `tag` |
| `noip_compliance` | compliance findings | `framework`, `control` |
| `noip_inventory_snapshots` | summarised cluster snapshots | `cluster`, `date` |
| `noip_analyses` | prior AI analysis outputs | `type`, `cluster` |

### Retrieval flow

1. `AIService.analyze*` builds a `query` from the request payload.
2. The **AnthropicAdapter** calls a **RAG client** (Python sidecar via gRPC,
   or local TS client) to fetch top-k chunks with metadata.
3. Retrieved chunks are appended to the prompt's `context` block under a
   stable `<context>` system tag (cache-friendly).
4. Resulting `AIAnalysisResult` records the IDs and confidence of retrieved
   contexts so audits can trace which knowledge influenced the answer
   (`AIAnalysisResult.context.relevantContextCount`,
   `AILearningPattern`).

### Updates

- `scripts/update_rag.py` is run on a schedule (daily) to ingest new
  inventory and report data.
- Dedup is by `id = sha256(content)` so repeated ingestion is idempotent.

### Positive Consequences

- Cheaper to operate than managed vector DBs at our current scale.
- Same store underpins "context-aware" analyses and the "learning patterns"
  feature already declared in the type system.

### Negative Consequences / Trade-offs

- Operational ownership of a stateful service.
- Cross-language boundary (Python ingestion ↔ TS retrieval) — handled by
  ACL (DDD-16).

## Pros and Cons of the Options

### ChromaDB

- 👍 Open source, simple, persistent.
- 👎 Smaller community than pgvector.

### pgvector

- 👍 Reuses a possible future PostgreSQL footprint.
- 👎 Adds a relational DB we don't otherwise need.

### Managed (Pinecone, Weaviate)

- 👍 Operational simplicity.
- 👎 Cost; data egress.

### No RAG

- 👍 Simplest.
- 👎 Loses historical context, repeats prior mistakes.

## References

- `scripts/update_rag.py`
- `docs/PYTHON_RAG_DASHBOARD_PLAN.md`
- ADR-0012 (Anthropic Claude)
