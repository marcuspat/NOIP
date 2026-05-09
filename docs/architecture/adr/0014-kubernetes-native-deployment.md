# ADR-0014: Kubernetes-native deployment

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, SRE
- **Tags:** infrastructure, deployment

## Context and Problem Statement

NOIP's primary subject is Kubernetes infrastructure; deploying NOIP itself on
Kubernetes both eats our own dog food and gives us mature primitives for
rolling updates, secrets, autoscaling, and stateful services. The repo
already contains Kustomize-style manifests under `k8s/`.

## Decision Drivers

- Reproducible, declarative infrastructure.
- Integration with our security & compliance scanners (the platform scans
  itself).
- Horizontal scaling without re-platforming.
- Multi-environment promotion (dev → staging → prod) using overlays.

## Considered Options

1. **Plain Kubernetes manifests with Kustomize overlays** (current).
2. **Helm charts.**
3. **Operator-driven CRDs.**
4. **Serverless (Cloud Run / Lambda).**

## Decision Outcome

**Chosen option:** **Kustomize overlays over plain manifests** for the
platform itself. We will publish a Helm chart only if/when we ship NOIP for
external consumption (separate ADR).

### Manifest layout

```
k8s/
├── namespace/         # noip namespace + RBAC
├── deployments/       # noip-platform-deployment.yaml
├── services/          # ClusterIP/LB services + endpoints
├── ingress/           # ingress.yaml (TLS + host-based routing)
├── database/          # mongodb-statefulset.yaml, redis-statefulset.yaml
├── monitoring/        # prometheus deployment + scrape configmaps
├── configmaps/        # non-secret config
├── secrets/           # placeholders (real secrets via External Secrets / KMS)
└── security/          # NetworkPolicy, PodSecurityPolicy/PSA, RBAC
```

### Conventions

- One `Deployment` per stateless service; `StatefulSet` for Mongo/Redis.
- Liveness / readiness probes hit `/health` (ADR-0020).
- Resource requests/limits set on every container.
- Pod-level `securityContext`: non-root, read-only root FS, drop all caps.
- Network policies default-deny intra-namespace; allow-list per service.
- Image pull from a private registry; signed images verified by admission
  webhook (Sigstore Cosign — separate roadmap item).
- HPA on the `noip-platform` deployment based on CPU + custom metric
  (request rate).

### Positive Consequences

- Declarative, GitOps-friendly (Argo CD compatible).
- Same primitives we are already an expert on (we ship a Kubernetes
  intelligence platform).
- Clean separation between stateless API and stateful data plane.

### Negative Consequences / Trade-offs

- Kubernetes operational complexity.
- StatefulSets for MongoDB/Redis require backup, restore, and PV management
  procedures (covered in operational runbooks).

## Pros and Cons of the Options

### Kustomize

- 👍 Native, no templating engine; overlays clean for env promotion.
- 👎 Less expressive than Helm for highly parameterised distributions.

### Helm

- 👍 Standard for redistributable charts.
- 👎 Templating in YAML strings; we can move to Helm later for external
  packaging.

### Operator + CRDs

- 👍 Highest fidelity automation.
- 👎 Far more code to maintain than we need now.

### Serverless

- 👍 Zero infra ops.
- 👎 Stateful needs (Mongo, Redis, ChromaDB) misalign; egress cost; portability.

## References

- `k8s/`
- `docker/Dockerfile`
- ADR-0015 (Docker multi-stage)
- ADR-0020 (health checks)
- ADR-0023 (observability)
