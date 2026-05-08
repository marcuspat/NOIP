# Bounded Context: Identity & Access

> *Generic subdomain.* We use standard primitives — JWT, Argon2id, TOTP,
> RBAC — and resist the temptation to invent here.

## Purpose

Provide authentication, authorisation, MFA, and session management for
NOIP operators. Be the single source of truth for *who* is on the
system, *what they may do*, and *whether their session is still
valid*.

## Ubiquitous language (canonical)

`User` · `Role` · `Permission` · `Session` · `Access Token` ·
`Refresh Token` · `MFA Channel` · `Backup Code` · `Device
Fingerprint`. Definitions live in
[`../ubiquitous-language.md`](../ubiquitous-language.md).

## Source layout

| Concern               | File                                              |
| --------------------- | ------------------------------------------------- |
| Aggregate roots       | `src/models/{user,role,permission,session}.model.ts` |
| Domain service        | `src/services/auth.service.ts`                    |
| HTTP controller       | `src/controllers/auth.controller.ts`              |
| HTTP routes           | `src/routes/auth.routes.ts`                       |
| Auth utilities        | `src/utils/auth/{jwt,password,mfa,email,fingerprint}.util.ts` |
| Middleware            | `src/middleware/auth.middleware.ts`               |
| Types (shared kernel) | `src/types/auth.types.ts`                         |

## Aggregates

### User
- **Root**: `User` (`user.model.ts`).
- **Identity**: `UserId` (Mongo `_id`).
- **Embedded entities / VOs**:
  - `MfaEnrolment` — `{ channel, enrolledAt, isDefault, secretRef? }`.
    A `User` may have multiple, with at most one `isDefault`.
  - `BackupCode` — Argon2-hashed, single-use.
  - `PasswordHistoryEntry` — last *N* hashes; prevents reuse.
- **References**: `roles: RoleId[]`.
- **Invariants**:
  1. `email` is unique and case-folded.
  2. Exactly zero or one `MfaEnrolment.isDefault === true`.
  3. `password` is always Argon2id-hashed (pre-save hook).
  4. `passwordHistory` length ≤ `PASSWORD_HISTORY_DEPTH`.
  5. `failedLoginAttempts >= 5` ⇒ `lockedUntil` is set; logins fail
     until then.

### Role
- **Root**: `Role` (`role.model.ts`).
- **Identity**: `RoleId`.
- **References**: `permissions: PermissionId[]`, optional `parent: RoleId`.
- **Invariants**:
  1. `parent` chain is acyclic.
  2. `name` unique within tenant scope.

### Permission
- **Root**: `Permission` (`permission.model.ts`).
- **Identity**: `PermissionId`.
- **Value object**: `Conditions` (JSON object, allow-listed keys only).
- **Invariants**:
  1. `(resource, action)` pair is unique without conditions; with
     conditions the tuple `(resource, action, conditionsHash)` is
     unique.
  2. `action ∈ {read, write, delete, execute, *}`.

### Session
- **Root**: `Session` (`session.model.ts`).
- **Identity**: `SessionId`.
- **References**: `userId: UserId`.
- **Embedded VOs**: `DeviceFingerprint`, `GeoLocation` (best-effort).
- **State**: `active | revoked | expired`.
- **Invariants**:
  1. A session in `revoked` cannot transition back.
  2. `expiresAt` matches the refresh-token TTL.
  3. Mirror in Redis (`session:<sid>`) is authoritative for
     revocation; Mongo is durable record.

## Domain service

`AuthService` (`src/services/auth.service.ts`) encapsulates:

- `register(email, password, profile)` → `User` + `iam.UserRegistered`.
- `login(email, password, deviceCtx)` → `{ accessToken, refreshToken,
  mfaChallenge? }` + `iam.UserLoggedIn` or `iam.UserLoginFailed`.
- `refresh(refreshToken)` → rotates refresh; revokes old. Replay of an
  old refresh revokes the entire session
  ([ADR-0006](../../adr/0006-jwt-stateless-auth-with-rotation.md)).
- `enrolMfa(userId, channel)`, `verifyMfa(userId, channel, code)`.
- `revokeSession(sessionId, reason)` → `iam.SessionRevoked`.
- `changePassword(userId, oldPwd, newPwd)` — checks history,
  re-hashes, may rotate Argon2 parameters.
- `resolveEffectivePermissions(userId)` — walks roles + parent chain,
  unions permissions, attaches conditions.

## Domain events emitted

See [`../domain-events.md`](../domain-events.md):
`iam.UserRegistered`, `iam.UserLoggedIn`, `iam.UserLoginFailed`,
`iam.MfaEnrolled`, `iam.MfaChallengeFailed`, `iam.SessionRevoked`,
`iam.PasswordChanged`, `iam.RoleAssigned`.

## Integration with neighbouring contexts

- **All other contexts → IAM**: via `requireAuth()` and
  `requirePermission(resource, action)` middleware. Never read IAM
  models directly.
- **Audit & Logging**: every auth event is also an `AuditEvent`.
- **Security Operations**: subscribes to login-failed/MFA-failed
  events to compute brute-force risk scores. Cannot mutate IAM
  state; can request `revokeSession()` via the service interface.

## Cross-cutting requirements

- **Rate limiting** on `/auth/*` endpoints
  ([ADR-0014](../../adr/0014-rate-limiting-redis-backed-sliding-window.md)).
- **Redaction** of `password`, `mfaSecret`, `backupCodes`,
  `refreshToken` in any HTTP response and any log line
  ([ADR-0015](../../adr/0015-structured-logging-with-winston.md)).
- **Lockout policy**: 5 failures within 15 minutes ⇒ 2-hour lockout.
- **Password policy** (configurable in `src/config/index.ts`):
  min length 12, mixed case, digit, symbol; not in last *N*; not in
  a known-breach list (planned).

## Out of scope (deliberately)

- Federated identity (SSO/SAML/OIDC) — schema fields exist on
  `User` but no provider is integrated yet.
- Per-tenant data isolation at the storage level — single-tenant
  today; multi-tenant is enforced by `Permission.conditions`.
- WebAuthn / passkeys — planned addition to the MFA channel set.

## Open questions

- Whether to embed the *full* permission set in the access JWT or only
  a hash with a server-side resolution. Today: full set, capped in
  size.
- Whether to migrate `passwordHistory` to a separate aggregate if
  it grows unboundedly. Today: capped, so the User aggregate stays
  small.
