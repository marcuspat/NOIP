/**
 * Centralised secret redaction helper.
 *
 * Mandated by:
 *   - ADR-0010 (Anthropic Claude): scrub secrets before they reach LLM prompts.
 *   - ADR-0015 (Winston logging):  scrub secrets before they reach log lines
 *                                  and audit records.
 *
 * Usage:
 *   import { redact } from './utils/redact';
 *   logger.info('user updated', redact(userPayload));
 *
 * The module deliberately has no dependencies outside of node built-ins so
 * that it is safe to import from anywhere (including bootstrap code).
 */

/**
 * Case-insensitive patterns matched against object key names. Any value
 * whose key matches one of these patterns is replaced with the mask.
 *
 * Patterns are anchored so they match either the whole key (case-insensitive)
 * or the trailing portion of a key (e.g. `STRIPE_SECRET` matches `_SECRET`).
 */
export const SECRET_KEY_PATTERNS: RegExp[] = [
  /^password$/i,
  /^passwordHash$/i,
  /^mfaSecret$/i,
  /^mfaBackupCodes$/i,
  /^backupCodes$/i,
  /^token$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^setCookie$/i,
  /^apiKey$/i,
  /^secret$/i,
  /^privateKey$/i,
  /^creditCard$/i,
  /^ssn$/i,
  // Suffix matchers for env-style names.
  /_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
];

/**
 * Patterns matched against string *values*. Catches secrets even when the
 * key is not on the deny-list (e.g. JWTs pasted into a `note` field, PEM
 * blocks dumped into a generic `data` blob, etc.).
 */
export const SECRET_VALUE_PATTERNS: RegExp[] = [
  // PEM blocks (private keys, certs, etc.).
  /-----BEGIN [A-Z ]+-----/,
  // JWT-shaped strings: three base64url segments separated by dots.
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  // OpenAI-style API keys.
  /sk-[A-Za-z0-9]{20,}/,
  // AWS access key IDs.
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  // GitHub personal access tokens.
  /ghp_[A-Za-z0-9]{36}/,
];

export interface RedactOptions {
  /** Replacement string for redacted values. Defaults to `'[REDACTED]'`. */
  mask?: string;
  /** Maximum recursion depth before deeper structures are stringified. */
  depth?: number;
}

const DEFAULT_MASK = '[REDACTED]';
const DEFAULT_DEPTH = 8;

/**
 * Append a key pattern to the deny-list at runtime. Useful for plugins or
 * tenant-specific configuration that needs to scrub additional fields.
 */
export function addSecretKeyPattern(pattern: RegExp): void {
  SECRET_KEY_PATTERNS.push(pattern);
}

/**
 * Append a value-shape pattern to the deny-list at runtime.
 */
export function addSecretValuePattern(pattern: RegExp): void {
  SECRET_VALUE_PATTERNS.push(pattern);
}

function isSecretKey(key: string): boolean {
  for (const pattern of SECRET_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

function stringHasSecret(value: string): boolean {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBuffer(value: unknown): boolean {
  return (
    typeof Buffer !== 'undefined' &&
    typeof (Buffer as { isBuffer?: (v: unknown) => boolean }).isBuffer === 'function' &&
    Buffer.isBuffer(value)
  );
}

interface Ctx {
  mask: string;
  maxDepth: number;
  seen: WeakSet<object>;
}

function redactValue(value: unknown, depth: number, ctx: Ctx): unknown {
  // Primitives & nullish — passthrough (strings handled below).
  if (value === null || value === undefined) return value;

  const t = typeof value;

  if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
    return value;
  }

  if (t === 'function') {
    // Functions are not data; drop their identity but don't crash.
    return value;
  }

  if (t === 'string') {
    return stringHasSecret(value as string) ? ctx.mask : value;
  }

  // Date — passthrough as a fresh clone so we don't mutate.
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  // Buffer — never serialize raw bytes.
  if (isBuffer(value)) {
    return ctx.mask;
  }

  // Depth cap: deeper structures get stringified (and truncated), not
  // infinitely recursed. We still apply value-pattern redaction to the
  // resulting string so secrets don't leak through this escape hatch.
  if (depth > ctx.maxDepth) {
    let s: string;
    try {
      s = String(value);
    } catch {
      s = '[Unserializable]';
    }
    if (s.length > 256) s = s.slice(0, 256) + '...';
    return stringHasSecret(s) ? ctx.mask : s;
  }

  // Cycle guard for objects.
  if (typeof value === 'object') {
    if (ctx.seen.has(value as object)) {
      return '[Circular]';
    }
    ctx.seen.add(value as object);
  }

  // Arrays.
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = redactValue(value[i], depth + 1, ctx);
    }
    return out;
  }

  // Map — recurse into entries; if the *key* (when it is a string) matches
  // the deny-list, mask the value.
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string' && isSecretKey(k)) {
        out.set(k, ctx.mask);
      } else {
        out.set(k, redactValue(v, depth + 1, ctx));
      }
    }
    return out;
  }

  // Set — recurse into members.
  if (value instanceof Set) {
    const out = new Set<unknown>();
    for (const v of value.values()) {
      out.add(redactValue(v, depth + 1, ctx));
    }
    return out;
  }

  // Plain objects (and bare object-like records).
  if (isPlainObject(value) || (typeof value === 'object' && value !== null)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (isSecretKey(key)) {
        out[key] = ctx.mask;
      } else {
        out[key] = redactValue(src[key], depth + 1, ctx);
      }
    }
    return out;
  }

  return value;
}

/**
 * Deep-clone `input`, replacing any value whose key matches
 * {@link SECRET_KEY_PATTERNS} or whose string content matches
 * {@link SECRET_VALUE_PATTERNS} with `opts.mask`.
 *
 * The original input is never mutated. Cycle-safe via an internal WeakSet.
 */
export function redact<T>(input: T, opts?: RedactOptions): T {
  const ctx: Ctx = {
    mask: opts?.mask ?? DEFAULT_MASK,
    maxDepth: opts?.depth ?? DEFAULT_DEPTH,
    seen: new WeakSet<object>(),
  };
  return redactValue(input, 0, ctx) as T;
}

export default redact;
