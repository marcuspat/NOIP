# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records for NOIP. Each ADR
captures a single significant architectural choice — what was decided, why,
what alternatives were considered, and the consequences.

ADRs are **immutable once accepted**. If a decision changes, write a new ADR
that supersedes the old one and update the old one's *Status* line to point to
the replacement.

## Process

1. Copy [`template.md`](./template.md) to `NNNN-short-slug.md` using the next
   sequential number.
2. Fill in the sections. Keep it short — one page is the goal.
3. Open a PR with status `Proposed`. Link the ADR from any code change that
   relies on the decision.
4. After review, the merger flips the status to `Accepted` and updates the
   index below.

## Status legend

- **Accepted** — decision is current.
- **Proposed** — decision is under discussion, not yet binding.
- **Superseded by ADR-NNNN** — replaced; kept for historical context.
- **Deprecated** — no longer applies but no replacement is needed.

## Index

| #    | Title                                                                                                                                       | Status   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Record architecture decisions](./0001-record-architecture-decisions.md)                                                                    | Accepted |
| 0002 | [TypeScript on Node.js as the primary runtime](./0002-typescript-and-nodejs-runtime.md)                                                     | Accepted |
| 0003 | [Express 5 as the HTTP framework](./0003-express-as-http-framework.md)                                                                      | Accepted |
| 0004 | [MongoDB as the primary datastore](./0004-mongodb-as-primary-datastore.md)                                                                  | Accepted |
| 0005 | [Redis for cache, sessions, and rate limiting](./0005-redis-for-cache-sessions-rate-limiting.md)                                            | Accepted |
| 0006 | [Stateless JWT authentication with refresh-token rotation](./0006-jwt-stateless-auth-with-rotation.md)                                      | Accepted |
| 0007 | [Argon2id for password hashing](./0007-argon2-for-password-hashing.md)                                                                      | Accepted |
| 0008 | [Multi-channel MFA: TOTP primary, SMS/email fallback](./0008-mfa-multi-channel-totp-sms-email.md)                                           | Accepted |
| 0009 | [Role-Based Access Control with conditional permissions](./0009-rbac-with-conditional-permissions.md)                                       | Accepted |
| 0010 | [Anthropic Claude as the AI provider](./0010-anthropic-claude-as-ai-provider.md)                                                            | Accepted |
| 0011 | [AgentDB and ReasoningBank adapter pattern for AI memory](./0011-agentdb-and-reasoningbank-adapter-pattern.md)                              | Accepted |
| 0012 | [Modular monolith with explicit bounded contexts](./0012-bounded-context-modular-monolith.md)                                               | Accepted |
| 0013 | [Framework-agnostic compliance control model](./0013-compliance-framework-agnostic-control-model.md)                                        | Accepted |
| 0014 | [Redis-backed sliding-window rate limiting](./0014-rate-limiting-redis-backed-sliding-window.md)                                            | Accepted |
| 0015 | [Structured logging with Winston + correlation IDs](./0015-structured-logging-with-winston.md)                                              | Accepted |
| 0016 | [Container security: non-root, read-only rootfs, seccomp](./0016-container-security-non-root-readonly-root.md)                              | Accepted |
| 0017 | [Kubernetes deployment strategy: RollingUpdate, PDB, NetworkPolicy](./0017-kubernetes-deployment-strategy.md)                               | Accepted |
| 0018 | [Secrets management via environment variables and Kubernetes Secrets](./0018-secrets-management-env-and-k8s-secrets.md)                    | Accepted |
| 0019 | [Testing strategy: Jest + Supertest + Playwright pyramid](./0019-testing-strategy-jest-supertest-playwright.md)                             | Accepted |
| 0020 | [API versioning under `/api/v1`](./0020-api-versioning.md)                                                                                  | Accepted |
