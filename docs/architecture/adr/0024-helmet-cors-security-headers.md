# ADR-0024: Security headers via Helmet and CORS policy

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security
- **Tags:** security, http
- **Implementation:** Complete (2026-05-16) — wired via securityHeadersMiddleware() + corsAllowList() factories.

## Context and Problem Statement

Browser-facing APIs must set conservative security headers (HSTS, CSP,
X-Content-Type-Options, X-Frame-Options, Referrer-Policy, COOP/COEP) and
constrain CORS to known origins. The codebase uses `helmet()` and `cors()` in
`src/app.ts` with defaults; we lock down the configuration here.

## Decision Drivers

- Defence in depth for the dashboard.
- Compliance with browser-security best practices (OWASP, MDN).
- Don't break legitimate cross-origin clients (CLI / partner integrations).

## Considered Options

1. **Helmet with explicit policy + CORS allow-list.**
2. **WAF-only** (rely on edge to inject headers).
3. **Defaults of each library, no explicit policy.**

## Decision Outcome

**Chosen option:** Option 1.

### Helmet policy

```ts
helmet({
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'strict-dynamic'", `'nonce-${nonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'"], // dashboard-only; reduce when feasible
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.anthropic.com"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    }
  },
  referrerPolicy: { policy: "no-referrer" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginEmbedderPolicy: false, // dashboard pulls fonts; revisit
  crossOriginResourcePolicy: { policy: "same-site" },
  xContentTypeOptions: true,
  frameguard: { action: "deny" }
})
```

Toggles:

- `ENABLE_HSTS`, `ENABLE_CSP`, `ENABLE_XFRAME`, `ENABLE_XCONTENT` allow
  per-environment relaxation (dev/test only); production defaults are all
  enabled.

### CORS

- Allow-list driven by `CORS_ORIGINS`, comma-separated.
- `credentials: true` only when `CORS_CREDENTIALS=true` and the origin is in
  the allow-list (no `*` with credentials).
- `Vary: Origin` is set on responses (Helmet handles this).
- Pre-flight cache: `Access-Control-Max-Age: 600`.

### Cookie policy (where used)

- `Secure`, `HttpOnly`, `SameSite=Strict` for any session-bearing cookies.
- We prefer Authorization headers over cookies for our token model
  (ADR-0006).

### Positive Consequences

- Strong default posture.
- Explicit config is auditable.

### Negative Consequences / Trade-offs

- CSP tuning for the dashboard requires diligence as new third-party assets
  are added.

## References

- `src/app.ts`
- ADR-0006, ADR-0019.
