# External Secrets Operator manifests (ADR-0025)

Production secrets for NOIP are sourced via the External Secrets Operator
(ESO). The manifests in this directory:

1. Define one `SecretStore` per cluster — examples for both **HashiCorp
   Vault** and **AWS Secrets Manager** are provided as siblings, keep only
   the one your environment uses.
2. Define one `ExternalSecret` per secret category from
   [ADR-0025 §Categories](../../../docs/architecture/adr/0025-secrets-management.md).
   ESO syncs each one into a real `Secret` object every `refreshInterval`.

## Layout

| File | Purpose |
|------|---------|
| `secret-store.vault.yaml` | `SecretStore` backed by HashiCorp Vault KV v2 |
| `secret-store.aws.yaml` | `SecretStore` backed by AWS Secrets Manager |
| `externalsecret-jwt.yaml` | `JWT_SECRET` + prior-kid window |
| `externalsecret-mongodb.yaml` | MongoDB connection URI |
| `externalsecret-redis.yaml` | Redis password |
| `externalsecret-ai-api-key.yaml` | Anthropic API key |
| `externalsecret-tls.yaml` | mTLS server cert + private key |
| `externalsecret-sso.yaml` | SSO client secrets per provider |

## Apply order

```bash
# 1. Install the operator (one-time, cluster-admin):
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
    --namespace external-secrets-system --create-namespace

# 2. Apply the store appropriate for your cloud:
kubectl apply -f k8s/secrets/external-secrets/secret-store.vault.yaml
# OR
kubectl apply -f k8s/secrets/external-secrets/secret-store.aws.yaml

# 3. Apply every ExternalSecret manifest:
kubectl apply -f k8s/secrets/external-secrets/
```

ESO will create / update a real `Secret` named in each manifest's
`spec.target.name` field. Pods consume those via `envFrom` /
`volumeMounts` exactly as if they were hand-crafted Secret objects.

## Rotation

Rotation is operator-driven and **does not require a redeploy** for most
secrets — ESO re-syncs every `refreshInterval` and pods that read the
Secret via projected volumes pick up the new value on the next read.

For `JWT_SECRET` specifically, see ADR-0025: rotation uses the dual-key
window (`JWT_PRIOR_KIDS`) so in-flight tokens keep verifying until they
age out. The helper `src/utils/auth/jwt-key-rotation.ts` parses the env
shape that the ExternalSecret writes into the pod.
