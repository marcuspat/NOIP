# ADR-0006: Stateless JWT authentication with refresh-token rotation

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** authentication, security

## Context

NOIP serves a REST API consumed by the dashboard, by CI workflows, and
potentially by customer scripts. We need an authentication scheme that:

1. Scales horizontally across stateless replicas — no sticky sessions.
2. Survives a brief Redis outage gracefully (read-only for short windows).
3. Supports instant revocation when an admin disables a user or a session
   is suspected compromised.
4. Carries enough authorisation context (roles, permission summary,
   session id) to avoid a Mongo round-trip on every request.

## Decision

We issue **two JWTs per login**:

- An **access token** signed with HS256, short-lived (15 minutes), carrying
  `{ sub, sessionId, roles[], permissions[] }`.
- A **refresh token** signed with a separate secret, longer-lived (7 days),
  stored *only* as an opaque jti reference in Redis (`session:<sid>` →
  metadata + revocation flag).

On each protected request, `auth.middleware.ts` verifies the access JWT
*and* checks `session:<sid>` exists and is not revoked. If Redis is down,
the middleware falls back to JWT signature only and logs a warning — this
is the documented degraded mode.

Refresh-token **rotation**: on every `/auth/refresh`, the old refresh
token is invalidated and a new pair is issued. Reuse of a previously-
rotated refresh token revokes the entire session (token-replay defence).

## Alternatives considered

- **Sticky sessions + server-side cookies.** Simple but breaks horizontal
  scaling, complicates k8s rolling deploys, and is hostile to the API
  consumers above.
- **Opaque tokens (no JWT).** Every request becomes a Mongo/Redis lookup;
  worse latency, and the token carries no information for debugging.
- **Long-lived single token.** Cannot revoke without a server-side check
  on every request, defeating the "stateless" benefit; if leaked, blast
  radius is the full lifetime.

## Consequences

### Positive
- Replicas are stateless; rolling deploys are seamless.
- Authorisation decisions for the common case happen entirely from the
  JWT payload — sub-millisecond.
- Refresh rotation defends against token replay.
- Instant revocation via Redis flag.

### Negative / costs
- JWTs cannot embed every permission for very large RBAC sets — we embed
  a *summary*, then re-check fine-grained permissions in services that
  need them.
- Two tokens to manage, rotate, and document for clients.
- Clock skew between replicas requires a small leeway in `exp` checks.

### Risks and mitigations
- *Secret leakage.* `JWT_SECRET` and `JWT_REFRESH_SECRET` come from
  Kubernetes Secrets ([ADR-0018](./0018-secrets-management-env-and-k8s-secrets.md)).
  Rotation procedure is in `docs/OPERATIONAL_RUNBOOKS.md`.
- *Replay across services.* Tokens carry an `aud` claim restricted to
  `noip-api`; downstream services must verify it.
- *Session bloat.* Sessions auto-expire from Redis at refresh-token TTL;
  admins can mass-revoke via the user record's `passwordChangedAt`
  watermark.

## References

- `src/services/auth.service.ts` — issuance, verification, rotation.
- `src/middleware/auth.middleware.ts` — request-time enforcement.
- `src/utils/auth/` — JWT helpers, password hashing, MFA.
- `src/models/session.model.ts` — durable session record.
