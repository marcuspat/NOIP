// Condition evaluators — closed registry of ABAC predicates that may be
// attached to an RBAC permission via `Permission.conditions`.
//
// Per ADR-0008 and DDD-05 the registry is intentionally **closed**: new
// evaluators require an ADR. We do not parse user-supplied expression
// strings — that would be an arbitrary-code-execution vector with the
// blast radius of every authorisation decision.
//
// A condition map is a `Record<string, unknown>` where each key encodes
// the evaluator and its argument as `name(arg)` (e.g. `sameTenantAs(tenantId)`)
// and the value is an optional payload (used today only by `duringHours`).
//
// Aggregation is conjunctive: every predicate must allow for the overall
// decision to allow. Any single deny short-circuits with that reason.

import type { AuthorizationDecision } from './permission-resolver.service';

/** Context bag handed to every evaluator. Sourced by the middleware. */
export interface ConditionContext {
  /** Current authenticated user, partial — only the fields we may inspect. */
  user?: {
    _id?: string;
    id?: string;
    tenantId?: string;
    [key: string]: unknown;
  };
  /** Express-derived request bits, supplied by the middleware's contextFn. */
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  ip?: string;
  /** Current wall-clock instant. Tests may inject a fixed value. */
  now?: Date;
}

/** A single evaluator. Returns `null` if the predicate is satisfied. */
type Evaluator = (
  arg: string,
  payload: unknown,
  ctx: ConditionContext
) => string | null;

const NAME_PATTERN = /^([a-zA-Z]+)(?:\((.*)\))?$/;

/**
 * Parse an entry key into `(evaluator name, raw arg)`.
 *
 * `sameTenantAs(tenantId)` → `{ name: 'sameTenantAs', arg: 'tenantId' }`
 * `duringHours`           → `{ name: 'duringHours',  arg: '' }`
 */
function parseKey(key: string): { name: string; arg: string } | null {
  const m = NAME_PATTERN.exec(key.trim());
  if (!m) return null;
  return { name: m[1] ?? '', arg: m[2] ?? '' };
}

/**
 * `sameTenantAs(field)` — the value at `field` in the *request*
 * (`params|query|body`) must equal `user.tenantId`. We deliberately do
 * **not** fall back to reading the field off `user` — that would make the
 * predicate trivially true and defeat the intent of asserting a request
 * scope match.
 */
const sameTenantAs: Evaluator = (arg, _payload, ctx) => {
  const userTenant = ctx.user?.tenantId;
  if (typeof userTenant !== 'string' || userTenant.length === 0) {
    return 'no-user-tenant';
  }
  const candidate = readRequestField(arg, ctx);
  if (candidate === undefined) return 'tenant-field-missing';
  if (candidate !== userTenant) return 'tenant-mismatch';
  return null;
};

/**
 * `ownerOf(field)` — the value at `field.userId` (or just `field`) in
 * the *request* must equal the authenticated user's id.
 */
const ownerOf: Evaluator = (arg, _payload, ctx) => {
  const userId = ctx.user?._id ?? ctx.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    return 'no-user-id';
  }
  const raw = readRequestField(arg, ctx);
  const candidate = extractUserId(raw);
  if (candidate === undefined) return 'owner-field-missing';
  if (candidate !== userId) return 'not-owner';
  return null;
};

/**
 * `inIpRange(cidr)` — the request IP must fall inside the CIDR. IPv4 only
 * for now; IPv6 returns `not-implemented` deterministically rather than
 * silently allowing.
 */
const inIpRange: Evaluator = (arg, _payload, ctx) => {
  if (arg.length === 0) return 'cidr-missing';
  const ip = ctx.ip;
  if (typeof ip !== 'string' || ip.length === 0) return 'no-ip';
  const result = matchesCidrV4(ip, arg);
  if (result === 'not-ipv4') return 'not-ipv4';
  if (result === 'invalid-cidr') return 'invalid-cidr';
  return result ? null : 'ip-out-of-range';
};

/**
 * `duringHours({ start, end, tz })` — wall-clock window.
 *
 * `start` / `end` are `'HH:MM'` 24-hour strings. The window may straddle
 * midnight (`start > end`). `tz` is an IANA timezone honoured via
 * `Intl.DateTimeFormat`.
 */
const duringHours: Evaluator = (_arg, payload, ctx) => {
  if (typeof payload !== 'object' || payload === null) {
    return 'duringHours-payload-missing';
  }
  const p = payload as Record<string, unknown>;
  const start = typeof p['start'] === 'string' ? p['start'] : undefined;
  const end = typeof p['end'] === 'string' ? p['end'] : undefined;
  const tz = typeof p['tz'] === 'string' ? p['tz'] : undefined;
  if (!start || !end || !tz) return 'duringHours-args-missing';

  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin === null || endMin === null) return 'duringHours-args-invalid';

  const now = ctx.now ?? new Date();
  let nowMin: number;
  try {
    nowMin = nowMinutesIn(tz, now);
  } catch {
    return 'duringHours-tz-invalid';
  }

  // Inclusive of start, exclusive of end — same convention as cron.
  const inWindow =
    startMin <= endMin
      ? nowMin >= startMin && nowMin < endMin
      : nowMin >= startMin || nowMin < endMin; // wraps midnight
  return inWindow ? null : 'outside-hours';
};

/** Closed registry. New evaluators require an ADR — see ADR-0008. */
const REGISTRY: Readonly<Record<string, Evaluator>> = Object.freeze({
  sameTenantAs,
  ownerOf,
  inIpRange,
  duringHours,
});

/**
 * Evaluate a conditions map against a context. Returns `allow` if every
 * key resolves to a registered evaluator and every evaluator allows.
 *
 * Unknown evaluator names always deny with reason `unknown-condition` —
 * this is the explicit ADR-0008 behaviour to prevent silent passes.
 */
export function evaluateConditions(
  conditions: Record<string, unknown>,
  ctx: ConditionContext
): AuthorizationDecision {
  for (const [key, payload] of Object.entries(conditions)) {
    const parsed = parseKey(key);
    if (!parsed) {
      return {
        kind: 'deny',
        reason: 'unknown-condition',
      };
    }
    const evaluator = Object.prototype.hasOwnProperty.call(
      REGISTRY,
      parsed.name
    )
      ? REGISTRY[parsed.name as keyof typeof REGISTRY]
      : undefined;
    if (!evaluator) {
      return { kind: 'deny', reason: 'unknown-condition' };
    }
    const denyReason = evaluator(parsed.arg, payload, ctx);
    if (denyReason !== null) {
      return { kind: 'deny', reason: denyReason };
    }
  }
  return { kind: 'allow' };
}

/** Test/diagnostic helper. Never used by the request path. */
export function listConditionEvaluators(): ReadonlyArray<string> {
  return Object.keys(REGISTRY);
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/**
 * Read a dotted-field path against `params`, `query`, then `body`. We
 * deliberately do **not** include `user` here: every evaluator that
 * compares a request value against a principal attribute needs the value
 * to come from the *request* — falling back to the user would make the
 * predicate trivially true.
 */
function readRequestField(field: string, ctx: ConditionContext): unknown {
  const parts = field.split('.').filter(p => p.length > 0);
  if (parts.length === 0) return undefined;
  for (const bag of [ctx.params, ctx.query, ctx.body]) {
    if (bag === undefined) continue;
    const value = walk(bag, parts);
    if (value !== undefined) return value;
  }
  return undefined;
}

function walk(root: unknown, parts: ReadonlyArray<string>): unknown {
  let cursor: unknown = root;
  for (const p of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

/**
 * Pull a `userId` out of a possibly-nested value. Accepts a bare string
 * (id) or an object with a `userId` field.
 */
function extractUserId(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') {
    const maybe = (raw as Record<string, unknown>)['userId'];
    if (typeof maybe === 'string') return maybe;
  }
  return undefined;
}

function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(min) ||
    h < 0 ||
    h > 23 ||
    min < 0 ||
    min > 59
  ) {
    return null;
  }
  return h * 60 + min;
}

/**
 * Compute the local-time minute-of-day in `tz`. Throws on an invalid
 * timezone (caller maps that to a deny reason).
 */
function nowMinutesIn(tz: string, now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  });
  const parts = fmt.formatToParts(now);
  let h = 0;
  let m = 0;
  for (const part of parts) {
    if (part.type === 'hour') h = Number(part.value);
    else if (part.type === 'minute') m = Number(part.value);
  }
  // `'24:00'` happens for some locales — clamp.
  if (h === 24) h = 0;
  return h * 60 + m;
}

/**
 * IPv4 CIDR membership. Returns `'not-ipv4'` for IPv6 inputs and
 * `'invalid-cidr'` for malformed input — the caller maps these to deny
 * reasons.
 */
function matchesCidrV4(
  ip: string,
  cidr: string
): boolean | 'not-ipv4' | 'invalid-cidr' {
  // Strip a possible IPv4-mapped prefix (`::ffff:` form) so the rest of
  // the function can stay purely v4.
  const normalised = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (normalised.includes(':')) return 'not-ipv4';

  const slash = cidr.indexOf('/');
  if (slash < 0) return 'invalid-cidr';
  const baseStr = cidr.slice(0, slash);
  const bitsStr = cidr.slice(slash + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return 'invalid-cidr';

  const ipNum = ipv4ToInt(normalised);
  const baseNum = ipv4ToInt(baseStr);
  if (ipNum === null || baseNum === null) return 'invalid-cidr';

  if (bits === 0) return true;
  // Mask in unsigned 32-bit space; `>>>` keeps the result non-negative.
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    acc = (acc * 256 + n) >>> 0;
  }
  return acc;
}
