# ADR-0019: Configuration and feature flags via environment variables

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, SRE
- **Tags:** configuration, ops

## Context and Problem Statement

`src/config/index.ts` reads all configuration from environment variables with
sensible defaults. The codebase also gates behaviour on flags (e.g.
`AUTH_SERVICE_ENABLED`, `DISCOVERY_SERVICE_ENABLED`,
`AI_SERVICE_ENABLED`, `MOCK_DATA`). We need an ADR to make the rules of the
road explicit.

## Decision Drivers

- 12-factor app: configuration as environment, secrets as env-injected.
- Single, typed entry point for configuration.
- Per-environment overrides without code changes.
- Predictable defaults for local development.

## Considered Options

1. **Env vars + `dotenv`, with a single typed `config` object** (current).
2. **Hierarchical config files (`config/{dev,prod}.yaml`)**.
3. **Feature-flag SaaS** (LaunchDarkly, Unleash).

## Decision Outcome

**Chosen option:** Option 1, with a documented promotion path to **Unleash
(self-hosted)** for runtime feature flags when we need targeting beyond
boolean env flags.

### Rules

- Every configuration value is read once into the `config` object on import
  of `src/config/index.ts`. No code reads `process.env.*` directly.
- Defaults must produce a working *development* configuration with no env
  vars set.
- Production deployments **must** override secret-bearing values
  (`JWT_SECRET`, `MONGODB_URI`, `REDIS_PASSWORD`, `AI_API_KEY`) and any
  default that is unsafe in production.
- A startup validation step asserts:
  - `JWT_SECRET !== 'your-secret-key-change-in-production'` when
    `NODE_ENV === 'production'`.
  - All required values are present and non-empty.
  - Numeric values parse and are within sane bounds.
- All keys are documented in `docs/CONFIGURATION.md` (separate doc) with
  type, default, range, and ownership.

### Feature flags

- Boolean toggles named `<DOMAIN>_<FEATURE>_ENABLED`.
- Flag changes that affect security defaults require an ADR; flag changes for
  rollout / canary do not.

### Secret injection

Secrets are **never** committed; they are injected at runtime through
Kubernetes `Secret`s sourced from the External Secrets operator (KMS / Vault
backend). See ADR-0025.

### Positive Consequences

- Simple, predictable, audit-friendly.
- Compatible with Kubernetes ConfigMap / Secret patterns.

### Negative Consequences / Trade-offs

- Restart required to change a flag. Acceptable for now; runtime targeting is
  on the roadmap with Unleash.

## References

- `src/config/index.ts`
- ADR-0025 (secrets management)
