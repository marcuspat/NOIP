# ADR-0009: Role-Based Access Control with conditional permissions

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** security, authorization

## Context

NOIP has multiple operator personas — security analyst, compliance
auditor, platform admin, read-only executive — and tenants/projects in
the longer term. Three properties are required:

1. **Coarse role granting** for fast onboarding (assign "Analyst" rather
   than 30 individual permissions).
2. **Fine-grained resource/action permissions** so the same role can
   read clusters in tenant A but not tenant B.
3. **Auditability** — every permission grant must be reviewable.

Pure ACLs are unmaintainable; pure RBAC cannot express tenant scoping;
ABAC alone is hard to reason about for auditors.

## Decision

We implement **RBAC with conditional permissions**:

- A `Role` (`src/models/role.model.ts`) is a named bundle of
  `Permission` references. Roles can inherit from a parent role.
- A `Permission` (`src/models/permission.model.ts`) is a tuple of
  `(resource, action, conditions?)` where:
  - `resource` is a domain noun: `cluster`, `secret`, `compliance.report`,
    `user`, …
  - `action` is `read | write | delete | execute | *`.
  - `conditions` is an optional JSON object evaluated against the request
    context (e.g. `{ tenantId: "$user.tenantId" }`). Conditions are
    evaluated by a small, pure helper — no JS eval.
- A `User` has zero or more `Role` references; the effective permission
  set is the union, with conditions ANDed when present.

The `requirePermission(resource, action)` Express middleware in
`src/middleware/auth.middleware.ts` performs the check after JWT
verification.

## Alternatives considered

- **Pure RBAC (no conditions).** Insufficient for multi-tenant scoping.
- **Pure ABAC** with a policy DSL (e.g. OPA/Rego). Powerful but adds
  operational overhead and a steep learning curve disproportionate to
  current needs. Reconsidered if/when policy complexity grows.
- **Casbin or similar.** Overlaps too heavily with what Mongoose +
  middleware already give us; would be a third source of auth truth.

## Consequences

### Positive
- Roles cover 90% of grants; conditions handle the long tail.
- Effective permissions can be computed once at login and embedded in the
  JWT for the common case.
- Audit logs reference role and permission ids, not free text.

### Negative / costs
- Conditional evaluation must be carefully bounded — only declared keys,
  no expressions. Documented in the permission service.
- Inheritance loops must be detected at role creation.

### Risks and mitigations
- *Privilege escalation through condition keys.* Allowed condition keys
  are an explicit allow-list defined in code, not user-supplied.
- *Stale permissions in JWTs.* A `passwordChangedAt` watermark on the
  user invalidates older tokens; role/permission changes increment a
  per-user counter that is also embedded in the token.

## References

- `src/models/role.model.ts`, `src/models/permission.model.ts`.
- `src/middleware/auth.middleware.ts` — `requirePermission`.
- `src/services/auth.service.ts` — effective-permission computation.
