# DDD-17: Implementation Roadmap

This roadmap sequences the work to take NOIP from its current state (a
TypeScript/Express monolith with mock services for some domains) to the
fully implemented modular monolith described in DDD-01 through DDD-16. It
deliberately interleaves architecture, security, and domain work.

> The roadmap is presented in **phases**, not calendar dates. Phase
> completion criteria are explicit.

## Phase 0 — Foundations (architecture & guardrails)

**Outcome:** the architecture is enforceable, observable, and safe to
iterate on.

1. Adopt the `docs/architecture/` folder (this commit).
2. Add lint rules per ADR-0022 (`import/no-restricted-paths`) to enforce
   ADR-0010 / ADR-0011 boundaries.
3. Stand up `src/contexts/shared/kernel/` with branded IDs, time types,
   `DomainEvent` envelope, and `EventBus` (in-process).
4. Add a typed error hierarchy in `src/shared/errors/` (DDD-15).
5. Add `Idempotency-Key` middleware (DDD-15) and a `requestId` propagator.
6. Add health endpoints `/health/live`, `/health/ready`, `/health/startup`
   per ADR-0020.
7. Add OpenTelemetry SDK + Prometheus `/metrics` per ADR-0023.
8. Add startup config validation per ADR-0019.
9. Wire External Secrets per ADR-0025 (or stub via SOPS in dev).

**Done when:**

- `npm run lint:check` and `npm run typecheck` pass.
- `/metrics`, `/health/*` and tracing exports work in dev.
- A trivial domain event round-trips through the in-process bus and is
  persisted by an audit subscriber stub.

## Phase 1 — IAM hardening (Generic, blocking everything else)

**Outcome:** real, secure auth that other contexts can rely on.

1. Migrate password hashing to Argon2id with bcrypt fallback (ADR-0007).
2. Implement JWT issuance / verification with `jose`, refresh-token rotation,
   and Redis-backed denylist (ADR-0006).
3. Implement `requirePermission` middleware with cache + invalidation per
   ADR-0008.
4. Wire MFA (TOTP via `speakeasy`, backup codes, optional SMS/email) per
   ADR-0009.
5. Implement SSO adapters (OIDC first; SAML, LDAP, OAuth2 follow) per
   DDD-16.
6. Replace ad-hoc audit log calls with the audit middleware (ADR-0017) and
   `iam.*` domain events (DDD-12).
7. Implement rate-limit buckets per ADR-0016.
8. Wire `iam.api` barrel; remove cross-context imports of `User`/`Role`/
   `Permission` from other services.

**Done when:**

- All `/api/auth/*` endpoints pass integration tests against Mongo + Redis.
- `iam.api.authenticate` and `authorize` are the **only** way other services
  consume IAM.
- MFA enrolment + verification flows work end-to-end.

## Phase 2 — Discovery (Core)

**Outcome:** real Kubernetes inventory replaces the current mocks.

1. Build the `KubernetesAdapter` (DDD-16): in-cluster + out-of-cluster auth,
   paginated list calls, dynamic API discovery.
2. Implement the `Cluster`, `ClusterScan`, `ResourceSnapshot`,
   `DriftReport` aggregates and repositories (DDD-06, DDD-13, DDD-14).
3. Replace `DiscoveryService` mocks with real implementations.
4. Add scheduled scan job + drift detection.
5. Publish `discovery.*` domain events.
6. Move snapshot cold storage to S3-compatible object store after 90 days.
7. Expose `discovery.api` barrel.

**Done when:**

- A real cluster can be registered and scanned; snapshots are reproducible
  by hash.
- Drift reports are generated for two consecutive snapshots.
- Audit logs and Dashboard receive `discovery.*` events.

## Phase 3 — Security & Compliance (Core)

**Outcome:** real findings, real policies, real reports.

1. Implement `SecurityScan`, `Finding`, `SecurityPolicy`,
   `ComplianceReport` aggregates and repositories.
2. Wrap external scanners (Trivy, kube-bench, kube-linter, gitleaks-style)
   in a `ScannerAdapter`.
3. Implement the `PolicyEngine` and `SeverityClassifier`.
4. Implement compliance framework mappings (SOC2, ISO27001, HIPAA,
   PCI-DSS, GDPR) with seeded `ControlAssessment` definitions.
5. Build report rendering for compliance reports.
6. Publish `security.*` and `compliance.*` events.
7. Expose `security.api` barrel.

**Done when:**

- Running a scan over a real snapshot produces findings with stable
  fingerprints across re-runs.
- Compliance reports are generated and signable.
- Suppression / acknowledgement workflows produce correct audit trails.

## Phase 4 — AI Analysis (Core)

**Outcome:** Claude-backed analyses with citable RAG context.

1. Build `AnthropicAdapter` (DDD-16): retries, circuit breaker, token
   accounting, prompt caching.
2. Build `Redactor` and `PromptComposer`.
3. Build `ChromaAdapter` and `PythonRagBridge`; schedule
   `scripts/update_rag.py` ingestion.
4. Implement `Analysis`, `LearningPattern`, `AIContext` aggregates.
5. Wire feedback loop (`POST /ai/feedback/:analysisId`) into pattern
   learning.
6. Publish `ai.*` events.
7. Expose `ai.api` barrel.

**Done when:**

- AI analyses produce results that cite retrieved context IDs.
- Cost meters and budget breach events are wired.
- Provider-down behaviour returns 503 cleanly.

## Phase 5 — Performance, Dashboard, Audit hardening

**Outcome:** non-core functionality is production-grade.

1. Performance: probes, load tests, SLO computation against Prometheus.
2. Dashboard: full CRUD, widget data resolver, sharing, PDF export.
3. Audit: hash chain (sharded), immutable archive to Object-Locked S3,
   transparency log integration.
4. Notifications subscriber (Slack, email) on selected events.

**Done when:**

- Dashboards render real data from real contexts.
- Audit chain integrity verifier passes for a 30-day rolling window.
- Performance SLOs reflect actual platform health.

## Phase 6 — Refactor to context folders

**Outcome:** physical layout matches DDD-03.

1. Move `src/services/<x>.service.ts`, `src/controllers/<x>.controller.ts`,
   models, and routes into `src/contexts/<x>/{application, domain, infrastructure, http, api}/`.
2. Tighten lint rules to enforce barrel-only cross-context imports.
3. Ensure each context owns its own subset of MongoDB collections (no
   collection is read by two contexts).

**Done when:**

- `eslint --max-warnings=0` passes with the boundary rules turned on.
- All cross-context calls go through `…/api/index.ts`.

## Phase 7 — Optional service extraction (per ADR-0026)

**Outcome:** contexts that have outgrown the monolith run as their own
services.

1. Begin with the AI context (per ADR-0026 ordering).
2. Migrate JWTs to RS256 with JWKS (issuer remains IAM).
3. Promote the in-process bus to NATS JetStream (or Kafka).
4. Adopt distributed tracing with cross-service propagation.

**Done when:**

- AI context is deployable independently of the platform monolith.
- IAM publishes a JWKS endpoint; other services verify tokens against it.
- Domain events are delivered through the broker.

## Workstream cross-cutting

The following streams run in parallel from Phase 0 to Phase 6:

- **Testing pyramid**: each new aggregate ships with unit + integration
  tests; e2e Playwright suites for major flows.
- **Documentation**: ADRs for any new significant decision; per-context DDD
  docs are kept current.
- **Security**: continuous security review per `SECURITY.md`; secret
  rotation drills quarterly.
- **Operability**: runbooks per context (already drafted in
  `docs/OPERATIONAL_RUNBOOKS.md`).

## Acceptance criteria for "fully implemented"

- All seven contexts have real (non-mock) implementations.
- All cross-context interactions go through `…/api/index.ts` barrels.
- Audit captures every state-changing event and the chain integrity holds.
- IAM enforces RBAC + MFA + lockout + token revocation per ADRs.
- AI analyses are reproducible (Strategy + retrieved context IDs).
- All ADRs marked `Accepted` are reflected in the codebase.
