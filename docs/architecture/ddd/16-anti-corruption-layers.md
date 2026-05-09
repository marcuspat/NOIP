# DDD-16: Anti-Corruption Layers

An **Anti-Corruption Layer (ACL)** translates between NOIP's domain model and
an external system. It exists to prevent the foreign model from leaking into
our domain. Every external integration in NOIP must go through an ACL.

## ACL inventory

| ACL | NOIP-side caller | External system | Source location (target) |
|-----|------------------|-----------------|--------------------------|
| `KubernetesAdapter` | Discovery | kube-apiserver | `src/contexts/discovery/infrastructure/kubernetes/` |
| `CloudAssetAdapter` (future) | Discovery | AWS / Azure / GCP | `src/contexts/discovery/infrastructure/cloud/` |
| `VulnerabilityFeedAdapter` | Security | NVD, GHSA, vendor feeds | `src/contexts/security/infrastructure/vulns/` |
| `ScannerAdapter` | Security | Trivy, kube-bench, kube-linter, gitleaks | `src/contexts/security/infrastructure/scanners/` |
| `AnthropicAdapter` | AI | Anthropic Claude API | `src/contexts/ai/infrastructure/anthropic/` |
| `ChromaAdapter` | AI | ChromaDB | `src/contexts/ai/infrastructure/chroma/` |
| `PythonRagBridge` | AI | `scripts/update_rag.py`, `scripts/ai_analysis.py` | `src/contexts/ai/infrastructure/python/` |
| `SAMLAdapter`, `OIDCAdapter`, `LDAPAdapter`, `OAuth2Adapter` | IAM | external IdPs | `src/contexts/iam/infrastructure/sso/` |
| `SmtpAdapter` | IAM, Notifications | SMTP server | `src/contexts/iam/infrastructure/smtp/` |
| `KMSAdapter` | IAM, Audit | Vault / cloud KMS | `src/contexts/iam/infrastructure/kms/` |
| `PrometheusAdapter` | Performance, Audit | Prometheus | `src/contexts/performance/infrastructure/prometheus/` |
| `ObjectStorageAdapter` | Audit, Dashboard | S3-compatible storage | `src/shared/infrastructure/objectstore/` |
| `LoadTestAdapter` | Performance | k6 / autocannon | `src/contexts/performance/infrastructure/loadtest/` |
| `PdfRendererAdapter` | Dashboard | Headless Chromium / Kaleido | `src/contexts/dashboard/infrastructure/pdf/` |

## ACL responsibilities

Every adapter:

1. **Speaks the external protocol** (HTTP, gRPC, SDK, shell-out).
2. **Translates** external types to NOIP value objects/entities — and back
   again on writes. Foreign types **never** appear above the adapter.
3. **Contains policy on retries, timeouts, circuit breaking, and rate
   limits** — these are *integration* concerns and do not belong in domain
   code.
4. **Enforces redaction or capability constraints** appropriate to the
   external system.
5. **Emits integration metrics** (`*_external_request_total`,
   `*_external_request_duration_seconds`).

## Pattern

```ts
// Domain-side port (in src/contexts/<ctx>/domain/ports/)
export interface KubernetesClient {
  listResources(scope: ScanScope): AsyncIterable<KubernetesResourceRecord>;
  getCluster(spec: ClusterSpec): Promise<ClusterInfo>;
  // …
}

// Infrastructure-side adapter (in …/infrastructure/kubernetes/)
export class KubernetesAdapter implements KubernetesClient {
  constructor(private readonly cfg: K8sConfig, private readonly clock: Clock) {}
  async *listResources(scope: ScanScope) {
    // pagination, retries, mapping…
  }
}
```

The domain depends only on `KubernetesClient`. The composition root
(`src/app.ts`) injects `KubernetesAdapter`.

## Spotlights

### `AnthropicAdapter`

- Builds the system / user / tool messages from a `PromptComposer` template.
- Applies **prompt caching** by stabilising the system prompt across calls.
- Wraps every call with:
  - Bounded retry (3 attempts on `429`, `5xx`) with exponential backoff and
    full jitter.
  - **Circuit breaker** (open after 5 failures in 30 s; half-open after
    60 s).
  - Token-usage accounting → `noip_ai_request_tokens_total{type,direction}`.
  - Cost estimation via a configurable price table.
- Translates `Anthropic.Message` → domain `Insight[]`,
  `Recommendation[]`, `Prediction[]`.
- Surfaces errors as `BackpressureError` (open breaker), `RateLimitError`
  (429 after retries), `ProviderError` (semantic 4xx), `InternalError`.

### `KubernetesAdapter`

- Authenticates via in-cluster service-account token (preferred) or out-of-
  cluster kubeconfig.
- Discovers API groups dynamically (`/apis`) and respects `apiVersion`
  evolution.
- Paginates list calls with `limit` + `continue` tokens.
- Optionally watches for change streams (future) via long-lived watches.
- Translates `metadata.creationTimestamp`, `resourceVersion`, etc. into
  domain time / version types.

### SSO adapters

- Each adapter is a *Conformist* to the external protocol but presents a
  unified `SSOAuthenticator` interface to IAM:

  ```ts
  interface SSOAuthenticator {
    start(opts): Promise<SSORedirect>;
    complete(opts): Promise<SSOClaim>;
  }
  ```

- The returned `SSOClaim` is a deliberate subset (`provider`,
  `providerUserId`, `email?`, `displayName?`, `groups?`); whatever else the
  IdP sends is dropped at the boundary.
- Group-to-role mapping is policy-driven, not hard-coded in the adapter.

### `PythonRagBridge`

- Encapsulates the language boundary between TypeScript (AI service) and
  Python (`scripts/update_rag.py`, `scripts/ai_analysis.py`).
- Phase 1: invocation via subprocess with JSON over stdin/stdout (locked
  schema).
- Phase 2: gRPC service hosted in a sidecar container, using the same
  protobuf schema.
- Errors from Python are translated to typed TS errors; we never surface
  Python tracebacks to NOIP-domain code.

## Policy: failures at the boundary

| Failure mode | Adapter behaviour |
|-------------|-------------------|
| External 4xx (semantic) | Translate to a domain error (`ConflictError`, `ValidationError`). |
| External 429 / 5xx | Retry with backoff; on exhaustion → `BackpressureError`. |
| Network timeout | Same as 5xx. |
| Schema drift (unknown field) | Tolerate (parse loosely), log a warning. |
| Schema drift (missing required field) | Refuse, surface `ProviderError`. |

## Testing ACLs

- ACLs ship with **contract tests** that pin the wire format we depend on.
- Tests use VCR-style recorded fixtures or `nock`/`undici-mock` for HTTP.
- Heavyweight live tests (against a real Anthropic key, real cluster) run
  nightly in a dedicated environment, never on PR builds.
