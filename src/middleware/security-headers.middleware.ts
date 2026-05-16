// ADR-0024: Helmet-based security-headers middleware.
//
// Mounts an explicit Helmet policy (HSTS, CSP with per-request nonce,
// COOP/COEP, Referrer-Policy, X-Content-Type-Options, X-Frame-Options)
// in place of the bare `helmet()` defaults that previously sat in
// `src/app.ts`. The ADR documents the rationale; this module is the
// single place where the policy lives so it can be audited and unit
// tested in isolation.
//
// Wiring contract (see ADR-0024 + `src/app.ts` swap-in snippet):
//
//   app.use(nonceMiddleware());         // populates `res.locals.cspNonce`
//   app.use(securityHeadersMiddleware()); // reads the nonce when building CSP
//
// `nonceMiddleware` MUST run before `securityHeadersMiddleware` because
// helmet's CSP directive callbacks are invoked synchronously during
// response setup and read `res.locals.cspNonce`.
//
// Env toggles (per the ADR):
//   - ENABLE_HSTS, ENABLE_CSP, ENABLE_XFRAME, ENABLE_XCONTENT  → boolean
//     When false, the corresponding helmet option is *omitted* (not set
//     to `false`) so helmet's own defaults aren't silently re-enabled
//     for that header family.
//
// Keeping this as a factory (rather than a singleton const) lets tests
// inject overrides via the optional `overrides` parameter without
// mutating module-level state.

import crypto from 'node:crypto';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import helmet, { type HelmetOptions } from 'helmet';
import { config } from '../config';

/**
 * Shape of the security-headers config slice the factory reads. Mirrors
 * `config.security.headers` so tests can hand-craft a partial without
 * pulling the entire app config.
 */
export interface SecurityHeadersConfig {
  enableHSTS: boolean;
  enableCSP: boolean;
  enableXFrameOptions: boolean;
  enableXContentType: boolean;
  hstsMaxAge: number;
  hstsIncludeSubDomains: boolean;
  hstsPreload: boolean;
}

/**
 * Optional overrides supported by {@link securityHeadersMiddleware}.
 *
 * - `headers`: replace the slice of `config.security.headers` the
 *   factory would otherwise read. Used by tests to flip individual env
 *   toggles without touching `process.env`.
 * - `connectSrc`: append extra hosts to the `connect-src` directive.
 *   Useful for environments that talk to additional upstreams beyond
 *   `api.anthropic.com`.
 */
export interface SecurityHeadersOverrides {
  headers?: Partial<SecurityHeadersConfig>;
  connectSrc?: readonly string[];
}

/** Number of bytes of entropy in the CSP nonce. 16 bytes = 128 bits. */
const NONCE_BYTES = 16;

/**
 * Per-request nonce generator for the CSP `script-src` directive.
 *
 * Writes a 128-bit base64url-encoded nonce to `res.locals.cspNonce`.
 * The CSP directive callback registered by {@link securityHeadersMiddleware}
 * reads this value when assembling the policy header for the response.
 *
 * MUST be mounted before `securityHeadersMiddleware()`.
 */
export function nonceMiddleware(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.locals['cspNonce'] = crypto
      .randomBytes(NONCE_BYTES)
      .toString('base64url');
    next();
  };
}

/**
 * Build a helmet middleware with the ADR-0024 explicit policy.
 *
 * Honours the env toggles via `config.security.headers`. When a toggle
 * is `false` the corresponding helmet option is *omitted* from the
 * options object (rather than set to `false`) so any future helmet
 * default for that family isn't silently re-enabled.
 */
export function securityHeadersMiddleware(
  overrides: SecurityHeadersOverrides = {}
): RequestHandler {
  const headersCfg: SecurityHeadersConfig = {
    ...config.security.headers,
    ...overrides.headers,
  };

  // CSP `connect-src` allows the dashboard to talk to api.anthropic.com
  // (ADR-0024) plus any caller-supplied hosts. Caller wins on order so
  // the audit trail in policy headers is predictable.
  const connectSrc: readonly string[] = [
    "'self'",
    'https://api.anthropic.com',
    ...(overrides.connectSrc ?? []),
  ];

  const options: HelmetOptions = {
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // Dashboard pulls fonts cross-origin; revisit per ADR-0024 negative
    // consequence note before enabling.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  };

  if (headersCfg.enableHSTS) {
    options.hsts = {
      maxAge: headersCfg.hstsMaxAge,
      includeSubDomains: headersCfg.hstsIncludeSubDomains,
      preload: headersCfg.hstsPreload,
    };
  } else {
    options.hsts = false;
  }

  if (headersCfg.enableCSP) {
    options.contentSecurityPolicy = {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'strict-dynamic'",
          // helmet invokes this callback once per response and inserts
          // the returned string into the script-src directive. The
          // nonce was placed on `res.locals` by `nonceMiddleware()`.
          (_req, res) =>
            `'nonce-${(res as unknown as { locals: { cspNonce?: string } }).locals.cspNonce ?? ''}'`,
        ],
        // 'unsafe-inline' is the dashboard's current reality; reduce
        // when feasible per ADR-0024.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [...connectSrc],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    };
  } else {
    options.contentSecurityPolicy = false;
  }

  if (headersCfg.enableXFrameOptions) {
    options.frameguard = { action: 'deny' };
  } else {
    options.frameguard = false;
  }

  if (headersCfg.enableXContentType) {
    options.xContentTypeOptions = true;
  } else {
    options.xContentTypeOptions = false;
  }

  return helmet(options) as RequestHandler;
}

export default securityHeadersMiddleware;
