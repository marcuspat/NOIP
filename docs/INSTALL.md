# INSTALL — NetOps Intelligence Platform (NOIP)

This document covers three install paths:

- [Local development](#local-development) — what a contributor needs to run
  `npm run dev` and the unit suite on their laptop.
- [Continuous integration](#continuous-integration) — what the CI runner
  needs to reproduce the build / lint / typecheck / test gates.
- [Production (Kubernetes)](#production-kubernetes) — the operator's
  install path, including the External Secrets Operator (ADR-0025) and
  optional security-scanner binaries (ADR-0007).

The configuration surface is documented inline in
[`src/config/index.ts`](../src/config/index.ts) and validated at import time
by [`src/config/validation.ts`](../src/config/validation.ts). For day-2
operational runbooks see [`docs/RUNBOOK.md`](./RUNBOOK.md). For the test
matrix see [`docs/TESTING.md`](./TESTING.md).

---

## Local development

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18 LTS or newer (ADR-0002) | Use `nvm install --lts` if you don't have it. |
| npm | bundled with Node 18+ | We use `npm ci` for deterministic installs. |
| Docker | 20.10+ | Optional but recommended for running Mongo + Redis locally. |
| Docker Compose | v2 (bundled with modern Docker) | Used by `docker/docker-compose.yml`. |
| Git | 2.30+ | Required for the husky + `detect-secrets` pre-commit hook. |

### Clone and bootstrap

```bash
git clone https://github.com/marcuspat/NOIP.git
cd NOIP
npm ci
npm run prepare        # installs husky + the detect-secrets pre-commit hook
```

`npm run prepare` runs `husky` plus
[`scripts/install-git-hooks.cjs`](../scripts/install-git-hooks.cjs), which
wires `detect-secrets-hook` (ADR-0025) to `pre-commit`. Do not skip it —
the pre-commit gate is the only thing standing between a stray `.env` and
the repo.

### Configure environment

```bash
cp .env.example .env 2>/dev/null || true
$EDITOR .env
```

If `.env.example` is absent, start from this minimum set:

```env
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/noip
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=dev-secret-change-me-at-least-32-characters-long
LOG_LEVEL=debug
CORS_ORIGINS=http://localhost:3000
```

The full list of variables is enumerated in
[`src/config/index.ts`](../src/config/index.ts) (over 100 keys). When
`NODE_ENV=production`, `validateConfig()` refuses placeholder secrets,
short JWT keys, and unsafe CORS combinations.

### Run datastores locally

```bash
docker compose -f docker/docker-compose.yml up -d mongodb redis
```

Or `docker compose -f docker/docker-compose.yml up` to bring the full
local stack (API container + Prometheus + Grafana) up.

### Run the API in watch mode

```bash
npm run dev          # ts-node, watches src/app.ts
```

The composition root logs the bootstrap sequence; once you see
`startup complete`, hit:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

### Run the unit suite

```bash
npm test
```

Expected: `1025/1025 across 113 suites`. See
[`docs/TESTING.md`](./TESTING.md) for contract / benchmark / integration
layers.

---

## Continuous integration

CI runners need the same prerequisites as a developer machine, plus a
couple of secret-scanning binaries the pre-commit hook depends on.

### Required binaries

| Tool | Why | Install |
|------|-----|---------|
| Node.js 18+ | Build, lint, typecheck, test. | `actions/setup-node@v4` or distro package. |
| Python 3.11+ | Hosts `detect-secrets` (used by the pre-commit hook and `npm run secrets:scan`). | `actions/setup-python@v5`. |
| `pre-commit` | Runs the project hook config in CI parity with local. | `pip install pre-commit`. |
| `detect-secrets` | Scans for committed credentials (ADR-0025). | `pip install detect-secrets`. |

### Minimum CI step list

```bash
npm ci
npm run lint:check     # eslint, must exit 0
npm run typecheck      # tsc --noEmit, must exit 0
npm run build          # tsc emit, must exit 0
npm test               # full unit suite, 1025/1025 expected
npm run secrets:scan   # detect-secrets diff against .secrets.baseline
```

Contract and benchmark suites are **opt-in**; gate them on a separate CI
job that mounts the relevant external services (ChromaDB, Trivy, etc.).
See [`docs/TESTING.md`](./TESTING.md) §contract.

### Coverage

`npm run test:coverage` writes lcov + html under `coverage/`. The Jest
config enforces a global 80% threshold on branches, functions, lines,
and statements ([`jest.config.cjs`](../jest.config.cjs)).

---

## Production (Kubernetes)

The platform is deployed as Kubernetes-native manifests (ADR-0014) running
multi-stage Docker images (ADR-0015). The reference manifests live under
[`k8s/`](../k8s/); they are intentionally plain `kubectl apply`-able YAML
rather than a Helm chart so an operator can read every resource before
applying it.

### Cluster prerequisites

- Kubernetes 1.24+ with RBAC enabled.
- A storage class that supports `ReadWriteOnce` PVCs for the MongoDB
  StatefulSet and Redis.
- An Ingress controller (the manifests under `k8s/ingress/` assume
  `ingress-nginx`).
- Optional: `cert-manager` for automatic TLS rotation on the Ingress.

### Install the External Secrets Operator (ADR-0025)

Production deployments **must not** apply `k8s/secrets/secrets.yaml`
directly — it ships placeholder values for local testing only. Use the
External Secrets Operator (ESO) instead.

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
    --namespace external-secrets-system --create-namespace
```

Pick the backing store appropriate for your cluster:

```bash
# HashiCorp Vault
kubectl apply -f k8s/secrets/external-secrets/secret-store.vault.yaml

# OR AWS Secrets Manager
kubectl apply -f k8s/secrets/external-secrets/secret-store.aws.yaml
```

Then apply the `ExternalSecret` manifests (JWT, MongoDB, Redis, AI API
key, TLS, SSO):

```bash
kubectl apply -f k8s/secrets/external-secrets/
```

ESO will materialise real `Secret` objects with the names the
deployment expects. See
[`k8s/secrets/external-secrets/README.md`](../k8s/secrets/external-secrets/README.md)
for the full layout, including the `refreshInterval` semantics.

### Deploy the platform

```bash
kubectl apply -f k8s/namespace/
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/database/       # MongoDB + Redis StatefulSets
kubectl apply -f k8s/services/
kubectl apply -f k8s/deployments/    # API Deployment + HPA
kubectl apply -f k8s/security/       # NetworkPolicy + PSP + ResourceQuota
kubectl apply -f k8s/ingress/
kubectl apply -f k8s/monitoring/     # Prometheus + Grafana
```

The [`scripts/deploy.sh`](../scripts/deploy.sh) wrapper sequences these
steps and waits on readiness for each layer. Day-2 operations
(rolling updates, JWT rotation, audit-chain integrity check, scaling,
backup/restore) are in [`docs/RUNBOOK.md`](./RUNBOOK.md).

### Optional security-scanner binaries (ADR-0007)

The Security & Compliance context can run with two backends:

1. **Built-in scanners** — pure-TypeScript heuristics. Default; no
   binaries required.
2. **Real CLI scanners** — wraps industry tools when the binaries are
   present on the pod's `PATH`. Enabled by the relevant feature flags in
   `src/config/index.ts` (`SCANNER_*_ENABLED`).

| Binary | Purpose | Container image |
|--------|---------|------------------|
| `trivy` | Container image vulnerability scan | `aquasec/trivy:latest` |
| `kube-bench` | CIS Kubernetes benchmark | `aquasec/kube-bench:latest` |
| `kube-linter` | Static policy lint on workloads | `stackrox/kube-linter:latest` |
| `gitleaks` | Repository secret scan | `zricethezav/gitleaks:latest` |

Bake these into the deployment image, side-car them, or run them in a
dedicated scanner DaemonSet — the adapter shells out via `child_process`
so all three deployment shapes work.

Contract tests under `tests/contract/security/` exercise the real-binary
path; they skip cleanly when the binaries are absent
([`docs/TESTING.md`](./TESTING.md) §contract security).

---

## Verifying the install

After any install path, the following smoke checks must succeed:

```bash
curl -fsS http://<host>:3000/health/live      # 200, body "OK"
curl -fsS http://<host>:3000/health/startup   # 200 once bootstrap done
curl -fsS http://<host>:3000/health/ready     # 200 once Redis + Mongo reachable
curl -fsS http://<host>:3000/metrics | head   # Prometheus exposition
```

If `/health/ready` returns 503 for more than ~30 seconds after boot,
follow the failure-mode triage in
[`docs/RUNBOOK.md`](./RUNBOOK.md#common-failure-modes).
