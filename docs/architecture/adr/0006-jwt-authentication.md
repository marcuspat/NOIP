# ADR-0006: JWT-based authentication with access + refresh token pair

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, Security
- **Tags:** security, auth

## Context and Problem Statement

NOIP must authenticate browser clients, CLI/automation clients, and service
accounts uniformly, while supporting short-lived credentials, revocation, and
horizontally scaled API instances. Session affinity is undesirable.

## Decision Drivers

- Stateless validation on the API tier so any pod can serve any request.
- Short access-token lifetime to limit blast radius if leaked.
- Refresh-token rotation to bound theft windows.
- Compatibility with Passport JWT strategy and `jose` for JWS/JWE.
- Ability to revoke tokens (denylist or session invalidation).

## Considered Options

1. **JWT access + refresh pair, signed with HMAC (HS256), with Redis-backed
   refresh-token store and access-token denylist.**
2. **Server-side opaque tokens** stored in Redis.
3. **JWT with RS256 / EdDSA asymmetric keys** for cross-service trust.
4. **OAuth2 / OIDC by external IdP only** (no first-party tokens).

## Decision Outcome

**Chosen option:** Option 1 today; with a documented migration path to **Option
3 (asymmetric keys)** when the platform is split into multiple services that
must verify tokens without holding the signing secret (see ADR-0026).

Token shapes (see `src/types/auth.types.ts:JWTPayload`):

```ts
{
  sub: userId,
  username, email,
  roles: string[],
  permissions: string[],
  sessionId: string,
  type: 'access' | 'refresh',
  iss: 'NOIP Platform',
  aud: 'noip-client',
  iat, exp
}
```

Lifetimes:

| Token | Default | Configurable via |
|-------|---------|------------------|
| Access | 15 min | `JWT_ACCESS_EXPIRY` |
| Refresh | 7 days | `JWT_REFRESH_EXPIRY` |

Rotation rules:

- Each refresh issues a *new* refresh token; the previous one is denylisted.
- Theft detection: if a denylisted refresh token is presented, the entire
  session family is invalidated (force re-login on all devices).
- Logout revokes all access tokens whose `sessionId` matches.

### Positive Consequences

- Stateless validation in API gateway / middleware
  (`src/middleware/auth.middleware.ts`).
- Native fit for Passport JWT strategy (`passport-jwt`).
- Refresh rotation gives strong protection against stolen-token replay.

### Negative Consequences / Trade-offs

- HMAC means the signing secret is shared across all API replicas; rotation
  requires a brief overlap window (mitigated by including a `kid` claim and
  Redis-cached key set).
- Token denylist in Redis adds a Redis dependency to validation; we are
  willing to pay this cost for revocability and accept fail-closed behaviour
  on Redis outage.

## Pros and Cons of the Options

### JWT (HS256) + Redis denylist

- 👍 Stateless on the happy path; revocable on demand.
- 👎 HMAC secret distribution constraints in multi-service futures.

### Opaque tokens

- 👍 Trivial to revoke; no claim leakage.
- 👎 Every request hits Redis (we already do, but the JWT path lets us defer
  Redis where caches are warm).

### JWT (RS256/EdDSA)

- 👍 Public-key verification; no secret distribution.
- 👎 More complex key management today; we will adopt this when we split
  services (ADR-0026).

### External IdP only

- 👍 No first-party crypto.
- 👎 We need first-party machine-to-machine and CLI tokens; pure delegation
  is too restrictive.

## References

- `src/services/auth.service.ts`
- `src/middleware/auth.middleware.ts`
- `src/types/auth.types.ts`
- ADR-0009 (MFA)
- ADR-0026 (microservices evolution)
