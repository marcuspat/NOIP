# ADR-0025: Secrets management

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security, SRE
- **Tags:** security, ops
- **Implementation:** Complete (2026-05-16) — ExternalSecret manifests + SOPS config + detect-secrets pre-commit + JWT dual-key rotation helper.

## Context and Problem Statement

NOIP holds high-value secrets: `JWT_SECRET`, MongoDB password, Redis
password, `AI_API_KEY` (Anthropic), TLS keys, SSO client secrets. They must
not be committed, must be rotated, must be auditable, and must reach pods via
a secure channel.

The repo currently has `k8s/secrets/secrets.yaml` as a placeholder; this ADR
defines the production approach.

## Decision Drivers

- No secret in Git, ever.
- Rotation without a redeploy where possible.
- Per-environment isolation.
- Auditable access (who fetched what, when).

## Considered Options

1. **External Secrets Operator (ESO) backed by AWS Secrets Manager / GCP
   Secret Manager / HashiCorp Vault.**
2. **SOPS-encrypted manifests in Git.**
3. **Plain Kubernetes Secrets created out-of-band.**

## Decision Outcome

**Chosen option:** **External Secrets Operator** as the primary mechanism,
with **SOPS** allowed for low-risk, low-rotation values
(non-production environments only).

### Pattern

- Each secret in Vault / cloud SM is referenced by a Kubernetes
  `ExternalSecret` manifest in `k8s/secrets/`. ESO syncs into a real
  `Secret` object in the cluster.
- Pods consume secrets via env vars (`envFrom: secretRef`) or projected
  volumes for files (TLS).
- Rotation: writers update the source; ESO re-syncs every
  `refreshInterval=10m`. Apps that need to reload (e.g. JWT signing key)
  expose a SIGHUP handler or a `kid`-based key set in Redis.

### Categories and rotation cadence

| Secret | Rotation | Mechanism |
|--------|----------|-----------|
| `JWT_SECRET` | 90 days | dual-key window via `kid`. |
| MongoDB password | 90 days | rotate user password, ESO sync, rolling restart. |
| Redis password | 90 days | same as Mongo. |
| `AI_API_KEY` | 180 days | issue new, switch via env, revoke old. |
| TLS certs (mTLS) | 90 days | cert-manager. |
| SSO client secrets | per provider | manual rotation. |

### Local development

- `.env.local` holds dev-only secrets; gitignored.
- `dotenv` only loaded outside production (`config/index.ts:dotenv.config()`).
- Pre-commit hook (`detect-secrets`) scans staged files for high-entropy
  strings.

### Audit

- ESO logs all secret reads to the audit channel.
- Vault audit log retained 365 days.
- `iam.token.revoked` event emitted whenever JWT_SECRET is rotated and the
  old key set drains.

### Positive Consequences

- Strong separation of secret material from code.
- Rotation is automated.
- Pod restarts pull the latest secrets.

### Negative Consequences / Trade-offs

- Operator and Vault add operational complexity.
- Some secrets (JWT signing keys) require app-level dual-key support to avoid
  signing-window outages.

## References

- `k8s/secrets/secrets.yaml`
- ADR-0006, ADR-0019.
