# ADR-0026: Evolution path from modular monolith to microservices

- **Status:** Proposed
- **Date:** 2026-05-09
- **Deciders:** Architecture Working Group
- **Tags:** architecture, roadmap

## Context and Problem Statement

ADR-0011 commits us to a modular monolith. As load grows and contexts
diverge in scaling profile (AI is bursty and CPU-light but cost-heavy;
Discovery is scheduled and I/O-heavy; IAM is latency-critical) we will need
to extract some contexts into independent services. This ADR documents the
*conditions* and *mechanics* of extraction, not a calendar.

## Decision Drivers

- Independent scaling and release cadence.
- Failure isolation (an AI cost spike must not slow down auth).
- Team ownership (Conway's Law).
- Avoid premature distribution.

## Triggers (extract when ANY hold)

1. A context's deploy cadence is materially different (≥ 2× per week vs
   monolith).
2. A context's resource requirements (CPU, memory, GPU) diverge enough that
   sizing the monolith for it wastes capacity.
3. A context owns a workload that compromises the monolith's latency or
   reliability budget.
4. A separate team takes ownership.

## Order of extraction (recommended)

1. **AI Analysis** (`ai`) — separate scaling, distinct egress concerns,
   already integrates with Python sidecars.
2. **Audit & Observability** — pure consumer; isolating it limits write-side
   coupling.
3. **Infrastructure Discovery** — periodic, I/O-heavy; clean event surface.
4. **Security & Compliance**.
5. **Dashboard / Reporting** — read-side; can become a BFF.
6. IAM remains the platform "core" until last; it owns cross-cutting tokens.

## Mechanics

For each extracted context:

1. The context's `api/` barrel becomes the public RPC contract (gRPC + protobuf
   or HTTP+JSON; gRPC preferred). Generated stubs replace direct imports in
   the monolith.
2. Domain events move from in-process bus to a broker (NATS JetStream first;
   Kafka if ordering/throughput demands).
3. The context gets its own MongoDB database (still on the same cluster;
   tenancy by DB name) — DB-per-context replaces collection-per-context.
4. JWTs migrate from HS256 (shared secret) to **RS256 / EdDSA** with a JWKS
   endpoint published by IAM. All other services verify with the public key
   set; signing remains in IAM (ADR-0006 supersession trigger).
5. Distributed tracing (OTel) becomes mandatory across the boundary.
6. Saga / outbox patterns replace cross-aggregate transactions where they
   exist.

## Constraints during the transition

- No double-writes: if context A previously read context B's collection
  directly, that read becomes a synchronous API call **or** a read-model
  populated by domain events — not a parallel write.
- Each migration is its own ADR (e.g. `ADR-0030: Extract AI Analysis context
  into a service`).

## Pros and Cons

### Phased extraction

- 👍 Limits blast radius; learns operational lessons before IAM extraction.
- 👍 Keeps optionality.
- 👎 Requires sustained discipline to keep contracts stable.

### "Big bang"

- 👍 Done in one go.
- 👎 Risky; obscures cause/effect for incidents.

## References

- ADR-0011, ADR-0006, ADR-0018.
- DDD-04 (context map)
