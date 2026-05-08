# ADR-0020: API versioning under `/api/v1`

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** api, compatibility

## Context

NOIP's REST API is consumed by:

- The first-party dashboard (loosely coupled — we control both ends,
  but it must keep working through deploys).
- CI/CD pipelines that script against the API.
- Third-party integrations that we cannot redeploy at will.

A breaking change made carelessly will silently corrupt customer
automation. We need a versioning policy that:

1. Lets us evolve the API without breaking active integrations.
2. Makes deprecation visible.
3. Does not create a maintenance circus (we're not Stripe — we don't
   need one version per quarter).

## Decision

All routes are mounted under **`/api/v1`** (`src/app.ts`). Within v1
we follow these rules:

- **Additive changes** (new endpoints, new optional response fields,
  new optional request fields) ship without a version bump.
- **Breaking changes** require a new major version (`/api/v2`).
  v1 is kept alive for at least **12 months** after v2 ships.
- **Deprecations** are announced in `RELEASE_NOTES.md`, advertised
  with a `Deprecation` and `Sunset` HTTP header on the deprecated
  endpoint, and reported in `/healthz/info`.
- **Field removals** within a major version are forbidden.

Versioning is reflected in:

- The URL path (`/api/v1/...`) — primary signal for clients.
- The `X-API-Version` response header (informational, includes the
  build's git sha).
- OpenAPI / JSON schema documents are versioned per major (in
  `docs/api/v1/`).

## Alternatives considered

- **Header-based versioning** (`Accept: application/vnd.noip.v1+json`).
  Cleaner for some, but adds friction for `curl`/scripting users
  and makes route caching layers harder.
- **No versioning, rolling breaking changes.** Acceptable only if all
  consumers are first-party; we do not have that property.
- **Per-resource versioning.** Hard to reason about; rejected.

## Consequences

### Positive
- Clients have a stable contract; deprecations are loud.
- Internal refactors are unconstrained as long as they don't change
  the wire shape.
- v2 can be developed alongside v1 without forking the codebase
  (controllers can re-export v1 handlers where the change is small).

### Negative / costs
- 12-month overlap means dual-running two API surfaces during
  transitions.
- Discipline burden: PR review must catch unintentional breaking
  changes (e.g. tightening a previously-optional field).

### Risks and mitigations
- *Accidental breakage.* Contract tests against the OpenAPI spec
  fail CI on schema regressions.
- *Sprawling deprecations.* Deprecation tracker page in the docs
  lists every deprecated field/endpoint with its sunset date.

## References

- `src/app.ts` — route mounting under `/api/v1`.
- `src/routes/*.routes.ts`
- `RELEASE_NOTES.md`
