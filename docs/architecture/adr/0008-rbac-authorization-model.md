# ADR-0008: Role-based access control with explicit permissions

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security, Platform engineering
- **Tags:** security, auth, authorization

## Context and Problem Statement

NOIP serves multiple personas: platform administrators, security analysts,
compliance officers, dashboard viewers, and CI/CD service accounts. Each must
have *least-privilege* access across heterogeneous resources (Kubernetes
inventory, security scans, AI analyses, audit logs, dashboards, billing).

The codebase already models **Role**, **Permission**, **User**, **ApiKey**,
and **ServiceAccount** (`src/types/auth.types.ts`,
`src/models/role.model.ts`, `src/models/permission.model.ts`). We need an
explicit ADR to lock down semantics and the authorization algorithm.

## Decision Drivers

- Least-privilege by default.
- Auditable: every authorization decision must be derivable from data, not
  hard-coded.
- Hierarchical roles to reduce duplication (e.g. `security-admin` inherits
  from `security-analyst`).
- Compatible with API keys and service accounts.

## Considered Options

1. **RBAC with explicit `Permission` documents and role inheritance.**
2. **Pure ABAC** (attribute-based access control) using a policy engine
   (e.g. OPA).
3. **Code-level decorators / hard-coded checks.**
4. **RBAC + ABAC hybrid** — RBAC base, ABAC for fine-grained conditions.

## Decision Outcome

**Chosen option:** **RBAC with explicit permissions and optional
condition expressions** (Option 1 with hooks for Option 4 in the future).

### Permission shape

```ts
Permission {
  name: string,           // 'security.scan.read'
  resource: string,       // 'security.scan'
  action: string,         // 'read' | 'create' | 'update' | 'delete' | 'execute'
  conditions?: Record     // optional ABAC predicates evaluated at check time
  isSystem: boolean       // built-in permission, not user-editable
}
```

### Role shape

```ts
Role {
  name: string,           // 'security-admin'
  permissions: Permission[],
  parentRoles?: string[], // role hierarchy (acyclic graph)
  isSystem: boolean
}
```

### Effective permissions

`effective(user) = ⋃ permissions(role) for role in flatten(user.roles)
                 ∪ user.permissions /* direct grants */`

### Authorization algorithm (per request)

1. JWT middleware loads `roles` and `permissions` claims (already minted by
   `auth.service`).
2. The `requirePermission(resource, action)` middleware:
   - Looks up the effective permission set (cached in Redis under the
     `sessionId`).
   - Returns `403` if the requested `(resource, action)` is not present.
   - If `conditions` are present, evaluates them against the request context
     (`req.user`, `req.params`, `req.body`).
3. Decisions are emitted as audit events (ADR-0017).

### Built-in roles

| Role | Description |
|------|-------------|
| `super-admin` | All permissions; system-only assignment. |
| `platform-admin` | Manage users, roles, infrastructure config. |
| `security-admin` | Manage security policies and scans. |
| `security-analyst` | Read security scans, create remediation tickets. |
| `compliance-officer` | Read compliance reports, manage compliance policies. |
| `dashboard-viewer` | Read-only access to dashboards and aggregated metrics. |
| `service-account` | Programmatic access scoped by attached permissions. |

### Positive Consequences

- Permission grants are data, not code — auditable and reviewable.
- Role hierarchy reduces duplication.
- Hook for ABAC conditions without committing to a policy engine yet.

### Negative Consequences / Trade-offs

- Caching effective permissions at session boundaries means changes to a
  role propagate only after token refresh or cache invalidation; this is an
  accepted security trade-off and is mitigated by emitting a
  `permission.escalation` event (DDD-12) that forces session renewal.
- Without an ABAC engine, complex per-tenant rules need bespoke condition
  evaluators.

## Pros and Cons of the Options

### RBAC with explicit permissions

- 👍 Simple, transparent, auditable.
- 👎 Fine-grained per-tenant rules require condition extension.

### Pure ABAC / OPA

- 👍 Maximum expressiveness.
- 👎 Significant operational overhead (policy distribution, evaluation
  performance, policy testing tooling) we are not ready for.

### Hard-coded checks

- 👍 Trivial.
- 👎 Unmaintainable; not auditable.

### Hybrid

- 👍 Best of both.
- 👎 Phased introduction is preferable; we keep the door open with
  `Permission.conditions`.

## References

- `src/models/role.model.ts`, `src/models/permission.model.ts`
- `src/middleware/auth.middleware.ts`
- DDD-05 (IAM context)
- ADR-0006 (JWT)
- ADR-0017 (audit logging)
