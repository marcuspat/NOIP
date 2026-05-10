// requireMFAVerified — Express middleware factory enforcing the
// MFA-verification gate from ADR-0009.
//
// Branches:
//   * `req.user.mfaEnabled === false`
//       - within grace period -> pass with `X-MFA-Grace-Remaining` header
//       - past grace -> 401 `mfa-required`
//   * `req.user.mfaEnabled === true`
//       - session.mfaVerified === false -> 401 `mfa-step-up-required`
//       - else -> next()
//
// The middleware factory is exported for the composition root that the
// sibling Redis-foundation agent owns; we intentionally do not mount
// it in `src/app.ts` here.

import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../shared/errors';
import {
  MFAGraceOptions,
  isMFAGracePeriodActive,
  mfaGraceRemainingMs,
} from '../utils/auth/mfa-grace-period';

export interface MFAVerifiedRequest extends Request {
  user?: {
    _id?: unknown;
    mfaEnabled?: boolean;
    createdAt?: Date | string | number;
    [key: string]: unknown;
  };
  tokenPayload?: {
    mfaVerified?: boolean;
    [key: string]: unknown;
  };
  session?: {
    mfaVerified?: boolean;
    [key: string]: unknown;
  };
}

export interface RequireMFAVerifiedOptions extends MFAGraceOptions {
  /** Override how the middleware decides if the session is verified. */
  isSessionMFAVerified?: (req: MFAVerifiedRequest) => boolean;
  /** Override the clock; useful in tests. */
  now?: () => Date;
  /** Available step-up methods to surface in the 401 details. */
  availableMethods?: ReadonlyArray<'totp' | 'sms' | 'email' | 'backup'>;
}

export type RequireMFAVerifiedMiddleware = (
  req: MFAVerifiedRequest,
  res: Response,
  next: NextFunction
) => void;

const DEFAULT_METHODS: ReadonlyArray<'totp' | 'sms' | 'email' | 'backup'> = [
  'totp',
  'backup',
];

/**
 * Default lookup: prefer the JWT payload (`tokenPayload.mfaVerified`)
 * because the session record may not always be hydrated; fall back to
 * `session.mfaVerified`.
 */
function defaultSessionMFAVerified(req: MFAVerifiedRequest): boolean {
  if (req.tokenPayload?.mfaVerified === true) return true;
  if (req.session?.mfaVerified === true) return true;
  return false;
}

/**
 * Build a `requireMFAVerified` middleware. The factory reads no
 * external state, so it can be safely re-bound per-route.
 */
export function requireMFAVerified(
  options: RequireMFAVerifiedOptions = {}
): RequireMFAVerifiedMiddleware {
  const sessionVerified =
    options.isSessionMFAVerified ?? defaultSessionMFAVerified;
  const clock = options.now ?? (() => new Date());
  const methods = options.availableMethods ?? DEFAULT_METHODS;

  return function requireMFAVerifiedMiddleware(
    req: MFAVerifiedRequest,
    res: Response,
    next: NextFunction
  ): void {
    const user = req.user;
    if (user === undefined || user === null) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (user.mfaEnabled === true) {
      if (sessionVerified(req)) {
        next();
        return;
      }
      next(
        new UnauthorizedError('mfa-step-up-required', {
          step: 'mfa',
          methods: [...methods],
        })
      );
      return;
    }

    // mfaEnabled !== true (false / undefined) — apply grace policy.
    const now = clock();
    if (user.createdAt === undefined) {
      next(
        new UnauthorizedError('mfa-required', {
          step: 'mfa-enrolment',
        })
      );
      return;
    }
    const graceUser =
      user.mfaEnabled === undefined
        ? { createdAt: user.createdAt }
        : { createdAt: user.createdAt, mfaEnabled: user.mfaEnabled };
    if (isMFAGracePeriodActive(graceUser, now, options)) {
      const remainingMs = mfaGraceRemainingMs(graceUser, now, options);
      res.setHeader('X-MFA-Grace-Remaining', String(remainingMs));
      next();
      return;
    }

    next(
      new UnauthorizedError('mfa-required', {
        step: 'mfa-enrolment',
      })
    );
  };
}

// ---------------------------------------------------------------------------
// Default-enforcer registry — mirrors the `setDefault*` pattern that
// `requirePermission` uses elsewhere in the codebase. The composition
// root sets this once at startup so call-sites can call
// `requireMFAVerifiedDefault` without passing options.
// ---------------------------------------------------------------------------

let defaultEnforcer: RequireMFAVerifiedMiddleware = requireMFAVerified();

export function setDefaultMFAEnforcer(
  enforcer: RequireMFAVerifiedMiddleware
): void {
  defaultEnforcer = enforcer;
}

export function requireMFAVerifiedDefault(
  req: MFAVerifiedRequest,
  res: Response,
  next: NextFunction
): void {
  defaultEnforcer(req, res, next);
}

/** Test-only: reset to a fresh default enforcer. */
export function resetDefaultMFAEnforcer(): void {
  defaultEnforcer = requireMFAVerified();
}
