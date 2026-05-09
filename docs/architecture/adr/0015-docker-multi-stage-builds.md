# ADR-0015: Docker multi-stage builds for the platform image

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform engineering, SRE
- **Tags:** infrastructure, packaging

## Context and Problem Statement

The TypeScript build emits compiled JavaScript that needs to be packaged into
an image suitable for production. We want small, reproducible, and minimal-
attack-surface images.

## Decision Drivers

- Small final image (sub-200MB target).
- No build toolchain or dev dependencies in the runtime image.
- Reproducible builds across CI and developer machines.
- Compatible with Kubernetes resource limits and HPA.

## Considered Options

1. **Multi-stage Dockerfile** with `node:18-bookworm-slim` builder and
   `gcr.io/distroless/nodejs18` runtime.
2. **Single-stage with `node:18-alpine`.**
3. **Buildpacks (e.g. Paketo).**
4. **Bazel/`rules_oci`.**

## Decision Outcome

**Chosen option:** Multi-stage Dockerfile.

### Stages

1. **deps**: copy `package*.json`, run `npm ci --omit=dev`. Cached when
   lockfile is unchanged.
2. **build**: copy source and `tsconfig.json`, run `npm ci && npm run build`.
3. **runtime**: `gcr.io/distroless/nodejs18`, copy `node_modules` from `deps`
   and `dist/` from `build`. `USER nonroot`. `CMD ["dist/app.js"]`.

### Image rules

- Tag with the immutable git SHA (`noip/api:sha-<short>`); separately tag
  `:latest` and `:vX.Y.Z` for releases.
- All images are signed (Cosign keyless via OIDC) — admission policy in the
  cluster verifies signature.
- SBOM generated with Syft and attached as an attestation; vulnerability
  scan with Grype/Trivy in CI.
- `HEALTHCHECK` is delegated to Kubernetes probes (ADR-0020), not embedded.

### Test image

`docker/Dockerfile.test` extends the build stage with dev dependencies, used
by CI for `npm test` / Playwright `e2e`.

### Positive Consequences

- Final image contains only the Node runtime, `node_modules`, and `dist/`.
- Distroless base shrinks attack surface (no shell, no apt).
- Clean separation between dev and prod images.

### Negative Consequences / Trade-offs

- Distroless makes ad-hoc debugging harder; `kubectl debug` ephemeral
  containers are the supported workflow.

## References

- `docker/Dockerfile`, `docker/Dockerfile.dev`, `docker/Dockerfile.test`
- ADR-0014 (Kubernetes-native deployment)
