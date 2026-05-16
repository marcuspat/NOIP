// ADR-0024: CORS allow-list middleware factory.
//
// Wraps the `cors` package with allow-list semantics tighter than the
// library's defaults:
//
//   - Origin must appear verbatim in the configured list. We do *not*
//     echo arbitrary `Origin` headers back to the caller.
//   - `credentials: true` is only honoured when CORS_CREDENTIALS=true
//     AND the requesting origin is in the allow-list. A `*` allow-list
//     with credentials is rejected outright per the CORS spec — browsers
//     would refuse the response anyway, but we make the intent explicit.
//   - Pre-flight responses include `Access-Control-Max-Age: 600` so the
//     browser caches them.
//   - `Vary: Origin` is set on every response (the `cors` package does
//     this internally; we also assert it in tests).
//   - In dev/test, when `CORS_ORIGINS` is unset or contains only `*`,
//     we log a warning once and fall back to a conservative default
//     (`http://localhost:3000`).

import type { Request, RequestHandler, Response, NextFunction } from 'express';
import cors, { type CorsOptions } from 'cors';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * Configurable knobs for the CORS factory. Mirrors
 * `config.security.cors` so tests can build a partial without touching
 * `process.env`.
 */
export interface CorsAllowListOptions {
  /** Whether credentials are honoured at all. */
  credentials?: boolean;
  /** Pre-flight cache TTL (`Access-Control-Max-Age`). Defaults to 600. */
  maxAge?: number;
  /** Optional logger override (defaults to the shared winston logger). */
  log?: Pick<typeof logger, 'warn' | 'info' | 'error'>;
  /**
   * Environment override. Defaults to `process.env.NODE_ENV` so tests
   * can flip behaviour without mutating real env.
   */
  environment?: string;
}

/**
 * Conservative fallback origins for dev/test when the operator has not
 * configured a real allow-list. Production must supply CORS_ORIGINS.
 */
const DEV_DEFAULT_ORIGINS: readonly string[] = ['http://localhost:3000'];

/**
 * Normalise the incoming allow-list:
 *   - Trim whitespace.
 *   - Drop empties.
 *   - In dev/test, if the list is empty or only contains "*", warn and
 *     fall back to `DEV_DEFAULT_ORIGINS`.
 *   - In production, "*" is logged as an error but still returned so the
 *     factory can refuse credentialled requests against it.
 */
function normaliseOrigins(
  raw: readonly string[],
  environment: string,
  log: Pick<typeof logger, 'warn' | 'info' | 'error'>
): readonly string[] {
  const cleaned = raw.map(o => o.trim()).filter(o => o.length > 0);
  const isWildcardOnly = cleaned.length === 0 || cleaned.every(o => o === '*');
  const isDevOrTest = environment === 'development' || environment === 'test';

  if (isWildcardOnly && isDevOrTest) {
    log.warn(
      'CORS_ORIGINS is unset or "*" in dev/test; falling back to localhost defaults',
      { fallback: DEV_DEFAULT_ORIGINS }
    );
    return DEV_DEFAULT_ORIGINS;
  }

  return cleaned;
}

/**
 * Build a CORS middleware enforcing an explicit allow-list.
 *
 * @param origins  Allow-listed origins (typically `config.security.cors.origins`).
 * @param opts     Optional knobs. Defaults are read from
 *                 `config.security.cors` so production wiring is a
 *                 one-liner: `corsAllowList(config.security.cors.origins)`.
 */
export function corsAllowList(
  origins: readonly string[],
  opts: CorsAllowListOptions = {}
): RequestHandler {
  const log = opts.log ?? logger;
  const environment =
    opts.environment ?? process.env['NODE_ENV'] ?? config.app.environment;
  const credentials = opts.credentials ?? config.security.cors.credentials;
  const maxAge = opts.maxAge ?? config.security.cors.maxAge ?? 600;

  const allowList = normaliseOrigins(origins, environment, log);
  const allowSet = new Set(allowList);
  // A wildcard with credentials is unspecified-behaviour in browsers
  // and an explicit anti-pattern per the ADR. Detect it and force
  // credentials off — the `cors` package would happily echo `*` and
  // `credentials: true` together, which we refuse.
  const wildcardWithCredentials = credentials && allowSet.has('*');
  if (wildcardWithCredentials) {
    log.error(
      'CORS configured with credentials=true and origin "*"; forcing credentials=false (ADR-0024)',
      { origins: [...allowSet] }
    );
  }
  const effectiveCredentials = credentials && !allowSet.has('*');

  const corsOptions: CorsOptions = {
    // Custom origin callback — never echo arbitrary origins. The `cors`
    // package only sets `Access-Control-Allow-Origin` when the callback
    // resolves to a string or `true`; we resolve to the exact requested
    // origin only when it is in the allow-list, otherwise `false` (no
    // header is emitted and the browser blocks the response).
    origin(requestOrigin, callback) {
      // Same-origin / non-browser requests have no Origin header. Let
      // those through; CORS does not apply.
      if (!requestOrigin) {
        callback(null, false);
        return;
      }
      if (allowSet.has(requestOrigin)) {
        callback(null, requestOrigin);
        return;
      }
      if (allowSet.has('*')) {
        // Wildcard explicitly allowed by operator (non-credentials).
        callback(null, '*');
        return;
      }
      // Refuse: callback with `false` means no Allow-Origin header is
      // emitted. The cors package will still call `next()` so the
      // request proceeds; the browser enforces the policy on the
      // response. We do NOT throw — that would 500 on legitimate
      // non-CORS callers (e.g. server-to-server with an Origin header).
      callback(null, false);
    },
    credentials: effectiveCredentials,
    maxAge,
    // Ensure Vary: Origin is always set so caches don't serve a
    // response keyed for one origin to a request from another. The
    // `cors` package handles this for the origin callback path; we
    // double up below in the wrapper for the rejected case.
  };

  const corsMiddleware = cors(corsOptions);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Always advertise Vary: Origin, even when we refuse the request,
    // so downstream caches (CDN, ingress) don't collapse responses for
    // different origins.
    res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Origin'));
    corsMiddleware(req, res, next);
  };
}

/**
 * Append a token to a `Vary` header without producing duplicates.
 * `Vary` may already be set by upstream middleware (e.g. compression).
 */
function appendVary(
  existing: number | string | string[] | undefined,
  token: string
): string {
  if (existing === undefined) return token;
  const current = Array.isArray(existing)
    ? existing.join(', ')
    : String(existing);
  const tokens = current
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  if (tokens.some(t => t.toLowerCase() === token.toLowerCase())) return current;
  return [...tokens, token].join(', ');
}

export default corsAllowList;
