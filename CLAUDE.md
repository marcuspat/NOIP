# NOIP — Claude Code Context

**Last updated:** 2026-06-13
**Current version:** v1.0.0 (released 2026-06-13)
**Repo:** https://github.com/marcuspat/NOIP
**Owner:** Marcus Patman — Principal Agentic Engineer

---

## What is NOIP?

NetOps Intelligence Platform — AI-powered infrastructure observability and compliance.

- TypeScript 5.9 / Node 22 / Express 5.1 / MongoDB / Redis
- 7 REST API domains under `/api/v1/*`: auth, discovery, compliance, security, reports, dashboard, load-testing
- Hardened auth: Argon2id, JWT rotation, MFA (TOTP wired; SMS/email stubs), rate limiting, RBAC
- Docker + Kubernetes deployment manifests

---

## Current State (v1.0.0)

| Metric | Value |
|---|---|
| TypeScript errors | 0 |
| ESLint errors | 0 (292 warnings, mock/adapter layers) |
| Jest | 312 passing / 21 skipped / 0 failing |
| Statement coverage | ~44% |
| Build | Passing |

### Fully wired
- Auth stack end-to-end (Argon2id, JWT, TOTP MFA)
- MongoDB + Redis persistence and caching
- All 7 API domain routes
- Docker + K8s manifests

### Intentionally mocked (adapter pattern)
- Kubernetes discovery — returns fixtures
- LLM/AI service — mock responses
- SMS/email MFA channels — stubs

These are ports, not implementations. Swap the adapter, not the architecture.

---

## Architecture

- ADRs: `docs/ADR/`
- Domain model: `docs/DDD/`
- Use cases: `USE_CASE_GUIDE.md`

Key patterns: adapter pattern for all external integrations, RBAC on all authenticated routes, repository pattern for MongoDB, rate limiting on auth endpoints.

---

## v1.1.0 Open Issues

| Issue | Title |
|---|---|
| #3 | feat(k8s): replace Kubernetes adapter mock with real cluster discovery |
| #4 | feat(ai): wire real LLM provider for AI infrastructure summaries |
| #5 | feat(auth): wire SMS/email MFA production channels |
| #6 | chore(test): raise statement coverage to 80%+ CI gate |
| #7 | ci: add GitHub Actions pipeline |

---

## Dev Commands

```bash
npm run typecheck     # tsc --noEmit
npm run lint:check    # eslint
npm test              # jest
npm run test:coverage # jest --coverage
npm run build         # tsc
npm run dev           # ts-node src/app.ts
```

---

## Release History

| Version | Date | Notes |
|---|---|---|
| v1.0.0 | 2026-06-13 | Initial release. 312 tests, 7 API domains, full auth stack, adapter-mock integrations. |

---

*Maintained by Marcus Patman / AdventureWave Consulting*
