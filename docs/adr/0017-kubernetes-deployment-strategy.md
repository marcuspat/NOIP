# ADR-0017: Kubernetes deployment strategy — RollingUpdate, PDB, NetworkPolicy

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** deployment, kubernetes

## Context

NOIP must be deployable into customer-managed Kubernetes clusters with
varying scale, network policy, and tooling. The deployment must be:

1. Zero-downtime under normal upgrades.
2. Resistant to single-node failures.
3. Networked least-privilege by default.
4. Observable via the cluster's existing Prometheus stack.

## Decision

The manifests in `k8s/` define:

- **Deployment** with `replicas: 3`,
  `strategy: { type: RollingUpdate, maxUnavailable: 1, maxSurge: 1 }`.
  Readiness probes hit `/healthz/ready`, liveness probes hit
  `/healthz/live`.
- **PodDisruptionBudget** with `minAvailable: 2` so voluntary
  disruptions (node drains) do not take the service below quorum.
- **HorizontalPodAutoscaler** scaling on CPU and request rate
  (target 70% CPU, configurable).
- **StatefulSets** for MongoDB (3 members, replica set) and Redis
  (primary + replicas) with PersistentVolumeClaims.
- **NetworkPolicy** that:
  - Allows ingress only from the configured ingress controller and
    the cluster's metrics scraper.
  - Allows egress only to MongoDB, Redis, the Anthropic API, the
    cluster API server (for discovery), SMTP, and DNS.
- **ServiceAccount** bound to a `Role`/`RoleBinding` with the
  minimum verbs needed for the in-cluster discovery service to read
  the resources it scans.
- **ResourceQuota** and **LimitRange** at the namespace level.
- **PodSecurityStandards** label: `restricted`.

CI publishes images to GHCR; production deployment is GitOps-friendly
(no imperative `kubectl apply` in the path).

## Alternatives considered

- **Single replica.** Cheaper but no HA; rejected.
- **`Recreate` strategy.** Simpler than RollingUpdate but causes
  downtime on every deploy.
- **Helm chart from day one.** Considered; pure manifests are
  sufficient for the current parameter surface and easier to read.
  Migrating to a Helm chart later is a one-time mechanical effort.

## Consequences

### Positive
- Deploys are seamless; node drains do not page anyone.
- Network and RBAC default-denies unwanted traffic.
- Ready for `restricted` PSS — works in customer clusters with strict
  policy.

### Negative / costs
- Multi-replica + PDB requires at least 3 schedulable nodes during a
  voluntary disruption.
- StatefulSets demand storage class capacity planning.

### Risks and mitigations
- *Schema migration during rolling deploy.* Migrations run as a
  separate `Job` gated on success before the rolling deploy proceeds
  (see `scripts/`).
- *NetworkPolicy too tight in some clusters.* Egress allow-list is
  parameterised by Helm-style values; a customer can extend it
  without forking.

## References

- `k8s/noip-platform-deployment.yaml`
- `k8s/mongodb-statefulset.yaml`, `k8s/redis-statefulset.yaml`
- `k8s/network-policy.yaml`, `k8s/pod-disruption-budget.yaml`
- `docs/PRODUCTION_DEPLOYMENT_GUIDE.md`
