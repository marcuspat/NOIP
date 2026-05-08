# ADR-0018: Secrets management via environment variables and Kubernetes Secrets

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** security, configuration

## Context

NOIP needs to handle:

- JWT signing secrets (access and refresh).
- MongoDB and Redis credentials.
- `ANTHROPIC_API_KEY`.
- SMTP credentials for email OTP and notifications.
- Optional SMS provider credentials.

These must never appear in:

- Source control.
- Container images.
- Application logs.
- HTTP responses.

We also want secret rotation to be a tractable operation, not a
multi-day event.

## Decision

Configuration is **12-factor**: every secret is read from an
environment variable in `src/config/index.ts`, which centralises
parsing and provides typed defaults. No secret is hard-coded; tests
use synthetic values from `tests/fixtures/`.

In Kubernetes, secrets live in `Secret` objects mounted as environment
variables on the Pod. `imagePullSecrets` use the same mechanism for
private registries.

For higher-grade environments, the `Secret` objects are populated by
**External Secrets Operator** (or the customer's choice — Vault,
AWS/GCP/Azure secret managers, SOPS). Our manifests reference the
mounted env vars; the *source of truth* is pluggable.

We rotate secrets without downtime by:

1. Updating the secret with both old and new values where applicable
   (or by issuing a new key id alongside the old one for JWT).
2. Triggering a rolling restart so pods pick up the new env.
3. Removing the old value once all pods are on the new one.

## Alternatives considered

- **Hard-code in source.** Disqualifying.
- **Read from a config file in the image.** Image must be rebuilt to
  rotate; rejected.
- **Mount Vault directly in-process.** Possible and supported via
  External Secrets; we don't mandate it because not every customer
  runs Vault.

## Consequences

### Positive
- Source tree is safe to publish; CI does not need privileged
  credentials except for production deploys.
- Rotation is a `kubectl rollout restart` away.
- Compatible with most enterprise secret backends via External
  Secrets.

### Negative / costs
- Secrets in environment variables can leak via `/proc/<pid>/environ`
  or crash dumps. We mitigate by setting `readOnlyRootFilesystem`
  and by redacting `process.env` from any log output.
- Customers without External Secrets must operate raw `Secret`
  objects, which are base64 (not encrypted) at rest unless the cluster
  uses encryption-at-rest.

### Risks and mitigations
- *Accidental secret in a log.* Redaction allow-list in the logger
  ([ADR-0015](./0015-structured-logging-with-winston.md)) and unit
  tests that assert known secret keys never serialise.
- *Secret in container env visible to anyone with `kubectl exec`.*
  Operator role granting `exec` is reviewed in the runbook.

## References

- `src/config/index.ts`
- `k8s/secrets.example.yaml`
- `docs/PRODUCTION_DEPLOYMENT_GUIDE.md` — secret rotation runbook.
