# DDD-02: Ubiquitous Language

This glossary is the source of truth for terms used across documentation,
code, and conversation. **One term has one meaning per bounded context** —
where contexts share a word with different intents, both definitions are
listed and disambiguated.

## Cross-context

| Term | Definition |
|------|------------|
| **Actor** | The principal performing an action: a `User`, a `ServiceAccount`, or the `system` itself. |
| **Tenant** | A logical isolation boundary; today single-tenant per deployment. |
| **Cluster** | A Kubernetes cluster managed or observed by NOIP. |
| **Resource** | A Kubernetes object (`Pod`, `Service`, `Deployment`, etc.) or a cloud asset. |
| **Snapshot** | A point-in-time, immutable record of inventory or analysis. |
| **Finding** | A defect identified by a scan: vulnerability, misconfiguration, policy violation. |
| **Severity** | Categorical rank: `low`, `medium`, `high`, `critical`. |
| **Posture** | The aggregate state of security/compliance for a scope. |
| **Recommendation** | An actionable suggestion (no automated action). |
| **Confidence** | A 0–1 measure of certainty in an AI insight. |
| **Domain Event** | A fact that has happened in the domain (DDD-12). |

## Identity & Access Management (IAM) context

| Term | Definition |
|------|------------|
| **User** | A natural person with credentials and identity. |
| **Service Account** | A non-human principal that authenticates with an `ApiKey`. |
| **Role** | A named bundle of permissions; may inherit from parent roles. |
| **Permission** | A `(resource, action)` grant, optionally with conditions. |
| **Session** | An authenticated period bound to a device fingerprint and access/refresh token pair. |
| **Token** | A JWT (`access` or `refresh`) carrying `sub`, `roles`, `permissions`, `sessionId`. |
| **MFA Method** | A second-factor mechanism: `totp`, `sms`, `email`, `backup`. |
| **Backup Code** | A one-time recovery code generated at MFA enrolment. |
| **Lockout** | A state where login is temporarily refused after failed attempts. |
| **SSO Provider** | An external identity provider (`saml`, `oidc`, `ldap`, `oauth2`). |

## Infrastructure Discovery context

| Term | Definition |
|------|------------|
| **Cluster Scan** | An execution of cluster-wide inventory collection. |
| **Resource Snapshot** | A captured `KubernetesResource` at a moment in time. |
| **Namespace Inventory** | Set of resources scoped to a namespace. |
| **Drift** | A difference between two consecutive snapshots. |
| **Discovery Job** | The scheduled task that produces snapshots. |

## Security & Compliance context

| Term | Definition |
|------|------------|
| **Scan** | An execution of security checks against a target set of resources. |
| **Vulnerability** | A CVE-classified weakness in software. |
| **Misconfiguration** | A non-CVE policy violation (e.g. privileged pod). |
| **Secret Exposure** | A credential or key found in source/manifest. |
| **Compliance Framework** | A set of controls (SOC2, ISO27001, HIPAA, PCI-DSS, GDPR). |
| **Control** | A single requirement within a framework. |
| **Compliance Report** | A point-in-time assessment of control coverage. |
| **Policy** | A rule that scans evaluate (org-defined or framework-derived). |
| **Security Score** | An aggregate posture score (0–100) for a scope. |

## AI Analysis context

| Term | Definition |
|------|------------|
| **Analysis** | An invocation of `AIService` returning an `AIAnalysisResult`. |
| **Strategy** | A choice of model, prompt template, and retrieval policy. |
| **AI Context** | A retrieved RAG chunk used to ground an analysis. |
| **Learning Pattern** | A reusable observation derived from prior analyses. |
| **Insight** | A finding produced by AI analysis. |
| **Prediction** | A forward-looking AI-generated statement with confidence. |
| **Prompt Cache** | Anthropic-side cache of stable system prompts. |

## Performance context

| Term | Definition |
|------|------------|
| **Probe** | A measurement (latency, throughput) on a target endpoint. |
| **Load Test** | A scripted workload against a deployment. |
| **SLO** | A service-level objective (availability or latency). |
| **Budget** | The remaining error budget against an SLO. |

## Dashboard & Reporting context

| Term | Definition |
|------|------------|
| **Dashboard** | A user-defined arrangement of widgets. |
| **Widget** | A single visualisation unit (`chart`, `metric`, `table`, `alert`). |
| **Layout** | The grid/flex arrangement of widgets. |
| **Refresh Interval** | How often a widget pulls fresh data. |

## Audit & Observability context

| Term | Definition |
|------|------------|
| **Audit Log** | An append-only record of an actor performing an action on a resource. |
| **Security Event** | A typed signal of a security-relevant occurrence (DDD-12). |
| **Trace** | A distributed-tracing span tree. |
| **Metric** | A numeric time series (Prometheus). |
| **Alert** | A rule-driven notification of an SLO/SLI breach. |

## Disambiguation

Two terms appear in multiple contexts with different meanings:

- **"Scan"**
  - In **Discovery**: a *cluster scan* — an inventory collection run.
  - In **Security**: a *security scan* — an evaluation of policies/CVEs.
  - Code names are explicit (`ClusterScan` vs `SecurityScan`).
- **"Event"**
  - In **Audit & Observability**: a `SecurityEvent` audit record.
  - In **Cross-context messaging**: a `DomainEvent`.
  - Naming convention: `<context>.<aggregate>.<change>` for domain events;
    `SecurityEvent` is reserved for the Audit context.
