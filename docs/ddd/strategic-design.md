# Strategic Design

This document records the strategic-level domain model for NOIP: the
problem domain, its decomposition into subdomains, and where each
bounded context fits.

## 1. Domain vision

> NOIP gives infrastructure and security operators a continuously
> updated, AI-assisted view of *what they have*, *how it changes*,
> *what's wrong with it*, and *what the law/their auditor says about it*
> — and lets them act on that view without leaving the tool.

Concretely:

- **Discover** infrastructure (Kubernetes-first, multi-cloud-ready).
- **Inspect** it for secrets, vulnerabilities, drift, and integrity.
- **Reason** about it with an AI assistant that learns from prior
  analyses.
- **Report** against compliance frameworks (SOC2, ISO27001, GDPR,
  HIPAA, PCI-DSS).
- **Operate** the platform itself securely (auth, audit, RBAC, MFA).

## 2. Domain decomposition

We split the problem domain into **subdomains**, classified by
strategic importance. The classification drives investment: core
subdomains warrant the most engineering attention; generic subdomains
should be solved with off-the-shelf components.

| Subdomain | Type | What it is | Where it lives |
|---|---|---|---|
| **Infrastructure Discovery** | **Core** | Continuous, accurate, near-real-time inventory of cloud + Kubernetes resources. Hardest to do well; most differentiating. | `contexts/infrastructure-discovery.md` |
| **AI Intelligence** | **Core** | Pattern-aware analysis and recommendation, with memory across sessions. Differentiating against plain LLM-call competitors. | `contexts/ai-intelligence.md` |
| **Security Operations** | **Core** | Secret/vulnerability/drift detection and incident lifecycle. Highest customer-perceived value alongside discovery. | `contexts/security-operations.md` |
| **Compliance & Risk** | **Supporting** | Mapping of evidence to multi-framework controls. Important to customers but not novel — value comes from leveraging the core data. | `contexts/compliance-and-risk.md` |
| **Dashboard & Reporting** | **Supporting** | Aggregation, visualisation, export. Necessary surface, not the differentiator. | `contexts/dashboard-and-reporting.md` |
| **Performance & Observability** | **Supporting** | Self-monitoring of NOIP's own performance and load tests. Necessary for an enterprise-grade platform. | `contexts/performance-and-observability.md` |
| **Identity & Access** | **Generic** | Auth, RBAC, MFA, sessions. Solved problem; we use standard primitives (JWT, Argon2id, TOTP) and don't innovate here. | `contexts/identity-and-access.md` |
| **Audit & Logging** | **Generic** | Structured logs, correlation ids, request audit trail. We standardise on Winston + Mongo `SecurityEvent`. | `contexts/audit-and-logging.md` |

## 3. Bounded contexts

A **bounded context** is a deliberate boundary inside which a model has
*a single, consistent meaning*. Two contexts can use the same word
("User", "Resource", "Event") but mean different things.

The eight bounded contexts in NOIP correspond 1:1 to the eight
subdomains above. Each one owns:

- A vertical slice of the codebase: model(s), service, controller,
  routes.
- A portion of the ubiquitous language (with the canonical definition
  in [`ubiquitous-language.md`](./ubiquitous-language.md)).
- A clear set of incoming and outgoing integrations with its
  neighbours, documented in [`context-map.md`](./context-map.md).

## 4. Today's deployment vs. tomorrow's

Today all contexts run **in one process** (a modular monolith — see
[ADR-0012](../adr/0012-bounded-context-modular-monolith.md)). The
expected extraction order, if and when scale forces it, is:

1. **AI Intelligence** — naturally async, has its own throughput
   profile, expensive per request.
2. **Infrastructure Discovery** — can be moved next to the cluster it
   scans.
3. **Security Operations** — once Discovery is out, this becomes a
   natural fellow service.
4. The rest stay co-located unless a specific need arises.

Each extraction is a one-context-at-a-time operation, not a big-bang
re-architecture, *because* the contexts already enforce their
boundaries today.

## 5. Strategic patterns in use

- **Modular monolith** — physical packaging, logical bounded contexts.
- **Anti-Corruption Layer** between Discovery and the Kubernetes API,
  and between AI Intelligence and the Anthropic API — neither's
  vocabulary leaks into the rest of NOIP.
- **Conformist** between Compliance and the external compliance
  framework definitions (we map their controls to ours; we don't try
  to renegotiate the framework's vocabulary).
- **Shared kernel** kept deliberately tiny (`src/types/`): only stable,
  behaviour-free identifiers and enums.
- **Open Host Service** — every context exposes a service interface
  consumed in-process today, ready to become an HTTP/gRPC interface
  tomorrow.

## 6. Out of scope (deliberately)

- Multi-tenancy at the data-store level — supported via tenantId
  scoping on permissions but no per-tenant database/sharding today.
- Streaming pipelines / Kafka — discovery results are pulled, not
  streamed, until volumes justify it.
- Self-service customer onboarding — operator-managed today.
- A workflow/automation engine — recommended remediations are textual
  today; auto-remediation is deferred until the AI's track record is
  strong enough.
