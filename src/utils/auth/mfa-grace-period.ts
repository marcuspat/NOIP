// Grace-period helper for MFA enforcement (ADR-0009).
//
// Newly created users get `MFA_GRACE_PERIOD` (7 days default) to enrol
// MFA before the requirement is enforced. The middleware uses this to
// decide whether to short-circuit a 401 or pass through with a header.

const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MFAGraceUser {
  /** When the user was created. ISO string or Date. */
  createdAt: Date | string | number;
  /** Whether the user has already completed MFA enrolment. */
  mfaEnabled?: boolean;
}

export interface MFAGraceOptions {
  /** Override the default grace window (ms). */
  gracePeriodMs?: number;
}

function resolveGraceMs(opts: MFAGraceOptions | undefined): number {
  if (opts?.gracePeriodMs !== undefined) return opts.gracePeriodMs;
  const raw = process.env['MFA_GRACE_PERIOD'];
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_GRACE_MS;
}

function toMillis(d: Date | string | number): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'number') return d;
  const parsed = Date.parse(d);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Returns `true` while a user is still within their MFA grace window.
 * Already-enabled MFA users are never "in grace" — the helper only
 * applies to enforcement of `requireMFAVerified`.
 */
export function isMFAGracePeriodActive(
  user: MFAGraceUser,
  now: Date,
  opts?: MFAGraceOptions
): boolean {
  if (user.mfaEnabled === true) return false;
  const created = toMillis(user.createdAt);
  if (!Number.isFinite(created)) return false;
  const gracePeriodMs = resolveGraceMs(opts);
  if (gracePeriodMs <= 0) return false;
  const deadline = created + gracePeriodMs;
  return now.getTime() < deadline;
}

/**
 * Returns the remaining grace window in milliseconds, or `0` if the
 * user is past the deadline / has MFA already / has an invalid
 * createdAt.
 */
export function mfaGraceRemainingMs(
  user: MFAGraceUser,
  now: Date,
  opts?: MFAGraceOptions
): number {
  if (user.mfaEnabled === true) return 0;
  const created = toMillis(user.createdAt);
  if (!Number.isFinite(created)) return 0;
  const gracePeriodMs = resolveGraceMs(opts);
  if (gracePeriodMs <= 0) return 0;
  const remaining = created + gracePeriodMs - now.getTime();
  return remaining > 0 ? remaining : 0;
}
