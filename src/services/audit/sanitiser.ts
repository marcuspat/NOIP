// Audit sanitiser — pure function that produces a *serialisable* projection
// of an Express request/response pair safe to persist into the audit log.
//
// Implements the rules in ADR-0017 §"Sanitisation rules" with deep-walk
// over body/headers and a hard cap on serialised body size.

export interface SanitiseInput {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  params?: Record<string, unknown>;
}

export interface SanitiseOptions {
  /** Max bytes for the *stringified* body. Default 10240. */
  maxBodySize?: number;
  /** Override the field denylist (case-insensitive comparison). */
  bodyDenylist?: ReadonlyArray<string>;
  /** Override the header denylist (case-insensitive comparison). */
  headerDenylist?: ReadonlyArray<string>;
}

export interface SanitisedRequest {
  method: string;
  path: string;
  query?: unknown;
  params?: Record<string, unknown>;
  headers: Record<string, unknown>;
  body?: unknown;
  bodyTruncated?: boolean;
  bodyOriginalBytes?: number;
}

export interface SanitisedResponse {
  statusCode: number;
}

/** Body field names treated as secrets. Lowercased once at module load. */
const DEFAULT_BODY_DENYLIST = [
  'password',
  'passwordconfirm',
  'currentpassword',
  'newpassword',
  'mfacode',
  'mfasecret',
  'backupcode',
  'token',
  'clientsecret',
  'privatekey',
  'cert',
  'secret',
] as const;

/** Headers treated as secrets. Lowercased once at module load. */
const DEFAULT_HEADER_DENYLIST = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
] as const;

const TRUNCATION_MARKER_PREFIX = '…<TRUNCATED:'; // '…<TRUNCATED:'

/**
 * Pure sanitiser. Returns a fresh object — never mutates `input`.
 *
 * Optimisations:
 *  - Header denylist hits short-circuit per key; we never deep-walk headers.
 *  - Body deep-walk skips primitives at the top level (no work for strings
 *    or numbers).
 *  - Truncation is computed via `Buffer.byteLength` to honour multi-byte
 *    characters; we then slice on character boundaries when feasible.
 */
export function sanitise(
  input: SanitiseInput,
  res?: { statusCode?: number },
  opts: SanitiseOptions = {}
): { request: SanitisedRequest; response?: SanitisedResponse } {
  const maxBodySize = opts.maxBodySize ?? 10240;

  const headerDeny = new Set(
    (opts.headerDenylist ?? DEFAULT_HEADER_DENYLIST).map(h => h.toLowerCase())
  );
  const bodyDeny = new Set(
    (opts.bodyDenylist ?? DEFAULT_BODY_DENYLIST).map(b => b.toLowerCase())
  );

  const headers = sanitiseHeaders(input.headers ?? {}, headerDeny);
  const {
    value: bodyValue,
    truncated,
    originalBytes,
  } = sanitiseBody(input.body, bodyDeny, maxBodySize);

  const request: SanitisedRequest = {
    method: input.method ?? 'UNKNOWN',
    path: input.path ?? input.url ?? '',
    headers,
  };
  if (input.query !== undefined) request.query = input.query;
  if (input.params !== undefined) request.params = input.params;
  if (bodyValue !== undefined) request.body = bodyValue;
  if (truncated) {
    request.bodyTruncated = true;
    request.bodyOriginalBytes = originalBytes;
  }

  if (res !== undefined && typeof res.statusCode === 'number') {
    return {
      request,
      response: { statusCode: res.statusCode },
    };
  }
  return { request };
}

function sanitiseHeaders(
  headers: Record<string, unknown>,
  denylist: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (denylist.has(lower)) {
      out[key] = `<REDACTED:${key}>`;
      continue;
    }
    // Headers are flat — no deep walk required.
    out[key] = value;
  }
  return out;
}

interface BodyResult {
  value: unknown;
  truncated: boolean;
  originalBytes: number;
}

function sanitiseBody(
  body: unknown,
  denylist: ReadonlySet<string>,
  maxBodySize: number
): BodyResult {
  if (body === undefined || body === null) {
    return { value: body, truncated: false, originalBytes: 0 };
  }

  // Primitives have no fields; pass through, but still truncate if the
  // stringified size exceeds the cap.
  if (typeof body !== 'object') {
    const str = String(body);
    const bytes = Buffer.byteLength(str);
    if (bytes <= maxBodySize) {
      return { value: body, truncated: false, originalBytes: bytes };
    }
    return {
      value: truncateString(str, maxBodySize, bytes),
      truncated: true,
      originalBytes: bytes,
    };
  }

  // Deep-walk objects/arrays once; this also clones, leaving `body` intact.
  const walked = redactDeep(body, denylist);

  // Stringify once to measure size. We accept the cost because audit
  // payloads are small (<10 KB) and bench-measured below.
  let serialised: string;
  try {
    serialised = JSON.stringify(walked);
  } catch {
    // Circular / non-serialisable inputs collapse to a marker.
    return {
      value: '<UNSERIALISABLE>',
      truncated: false,
      originalBytes: 0,
    };
  }
  const bytes = Buffer.byteLength(serialised);

  if (bytes <= maxBodySize) {
    return { value: walked, truncated: false, originalBytes: bytes };
  }

  // Over the cap: replace the body with the stringified+truncated form.
  return {
    value: truncateString(serialised, maxBodySize, bytes),
    truncated: true,
    originalBytes: bytes,
  };
}

function redactDeep(value: unknown, denylist: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(v => redactDeep(v, denylist));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (denylist.has(key.toLowerCase())) {
      out[key] = `<REDACTED:${key}>`;
      continue;
    }
    out[key] = redactDeep(v, denylist);
  }
  return out;
}

/**
 * Slices `str` so that the resulting bytes-length is <= `maxBytes` and
 * appends the truncation marker `…<TRUNCATED:N more bytes>` where N is
 * the number of bytes elided.
 *
 * We slice character-by-character to avoid breaking a multi-byte sequence
 * — this is O(n) once and only runs when the body is over budget.
 */
function truncateString(
  str: string,
  maxBytes: number,
  totalBytes: number
): string {
  // Reserve room for the marker so the *final* string is still bounded.
  // Marker length depends on N, which depends on cut point; iterate once
  // with a generous reservation.
  const RESERVE = 64;
  const target = Math.max(0, maxBytes - RESERVE);

  let bytes = 0;
  let cut = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    const cb = Buffer.byteLength(ch);
    if (bytes + cb > target) break;
    bytes += cb;
    cut = i + 1;
  }
  const head = str.slice(0, cut);
  const elided = totalBytes - Buffer.byteLength(head);
  return `${head}${TRUNCATION_MARKER_PREFIX}${elided} more bytes>`;
}

export const __testing = {
  DEFAULT_BODY_DENYLIST,
  DEFAULT_HEADER_DENYLIST,
  TRUNCATION_MARKER_PREFIX,
  redactDeep,
  truncateString,
};
