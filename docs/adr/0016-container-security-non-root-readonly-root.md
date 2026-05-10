# ADR-0016: Container security — non-root, read-only rootfs, seccomp

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** security, containers

## Context

NOIP runs in containers in customer-controlled clusters. A compromise
of the application process should not yield a writable filesystem, a
root shell, or unrestricted system calls. Most CVEs we want to make
exploit-difficult require at least one of these.

Compliance frameworks NOIP itself reports on (CIS Kubernetes
Benchmark, NIST 800-190) require these defences.

## Decision

The production container image (`docker/Dockerfile`) is built with:

- **Multi-stage build** (`base` → `deps` → `builder` → `runtime`).
  Only the `runtime` stage ships; build tooling and node_modules
  caches stay behind.
- **Non-root user**: `USER 1001` (uid 1001 with no shell), declared in
  the runtime stage.
- **Minimal base** image (Alpine or distroless variant).
- **`dumb-init`** as PID 1 so SIGTERM propagates and zombies are
  reaped.
- **`HEALTHCHECK`** hits `/healthz` so orchestrators can detect
  liveness failures before traffic is routed in.

The Kubernetes Deployment (`k8s/noip-platform-deployment.yaml`) hardens
further:

- `runAsNonRoot: true`, `runAsUser: 1001`, `allowPrivilegeEscalation:
  false`.
- `readOnlyRootFilesystem: true` with `emptyDir` mounts where
  temporary files are needed (`/tmp`).
- `seccompProfile: { type: RuntimeDefault }`.
- `capabilities.drop: ["ALL"]`.
- Resource `requests` and `limits` set; pods cannot consume the node.

## Alternatives considered

- **Run as root for "convenience".** Permanent technical debt;
  rejected.
- **Single-stage Dockerfile.** Larger image, larger attack surface,
  build deps shipped to production.
- **Distroless without `dumb-init`.** Possible, but signal handling
  becomes fragile when the JS process is PID 1.

## Consequences

### Positive
- A compromised process cannot write the container filesystem,
  escalate privileges, or invoke uncommon syscalls.
- Image is small, fast to pull, fast to scan.
- Aligns with CIS Kubernetes Benchmark and NIST 800-190.

### Negative / costs
- A read-only rootfs means every directory the app writes must be a
  declared `emptyDir` or PVC; subtle bugs surface as `EROFS`.
- Multi-stage builds are slightly more complex to debug.

### Risks and mitigations
- *Library wants to write to `$HOME` or `/tmp` unexpectedly.* CI runs
  the image with the production security context; surfaces in tests
  rather than production.
- *seccomp profile breaks an obscure syscall.* `RuntimeDefault` is
  permissive enough for Node; we have not had to define a custom
  profile.

## References

- `docker/Dockerfile`
- `k8s/noip-platform-deployment.yaml` — `securityContext`.
- CIS Kubernetes Benchmark v1.8.
