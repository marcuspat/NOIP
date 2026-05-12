// Auth router (ADR-0006 + ADR-0009 + ADR-0016 follow-up).
//
// Refactored from a top-level module-side-effect export into a factory
// (`createAuthRouter`) so the composition root can thread in:
//   - the singleton `AuthService` (with the Redis-backed JWT denylist
//     wired per ADR-0006);
//   - the shared ioredis client used to back `createBucketLimiter`
//     (ADR-0016) — buckets `auth`, `password-reset` and `mfa` fail
//     CLOSED so a Redis blip cannot weaken brute-force protection.
//
// The legacy `RateLimitMiddleware` class is retired here. The
// per-bucket limiter is mounted explicitly per route group so each
// surface has the appropriate window/max and key-generator semantics
// from ADR-0016.

import { Router, type RequestHandler } from 'express';
import { body, query } from 'express-validator';

import { AuthController } from '../controllers/auth.controller';
import { AuthMiddleware } from '../middleware/auth.middleware';
import { AuditMiddleware } from '../middleware/audit.middleware';
import {
  createBucketLimiter,
  type BucketLimiterOptions,
} from '../middleware/rate-limit-redis';
import type { AuthService } from '../services/auth.service';
import type { SharedRedisClient } from '../database/shared-redis';
import logger from '../utils/logger';

/** ADR-0016 windows applied by the auth router. Centralised so tests can assert them. */
export const AUTH_LIMITER_WINDOWS: Record<
  'auth' | 'password-reset' | 'mfa',
  { windowMs: number; max: number }
> = {
  auth: { windowMs: 15 * 60 * 1000, max: 5 },
  'password-reset': { windowMs: 60 * 60 * 1000, max: 3 },
  mfa: { windowMs: 5 * 60 * 1000, max: 10 },
};

/**
 * Limiter factory the router consumes. The composition root injects
 * `createBucketLimiter` bound to the shared Redis client; tests pass a
 * lighter-weight stub so they can drive the route without a real Redis.
 */
export type AuthLimiterFactory = (opts: BucketLimiterOptions) => RequestHandler;

export interface CreateAuthRouterDeps {
  authService: AuthService;
  /** Shared ioredis client; required when no `limiterFactory` is supplied. */
  redisClient?: SharedRedisClient;
  /**
   * Override hook for tests: build a limiter for a given bucket without
   * touching the Redis-backed factory. When omitted we fall back to
   * `createBucketLimiter` bound to `redisClient`.
   */
  limiterFactory?: AuthLimiterFactory;
  /** Optional logger; defaults to the shared platform logger. */
  log?: typeof logger;
}

/**
 * Build the auth router. Mount with `app.use('/api/auth', router)` at
 * the composition root. The returned router is fully wired with
 * per-bucket Redis-backed rate limiters (ADR-0016) and the DI-built
 * AuthService (so the JWT denylist is reached per ADR-0006).
 */
export function createAuthRouter(deps: CreateAuthRouterDeps): Router {
  const router = Router();
  const authController = new AuthController({ authService: deps.authService });
  const authMiddleware = new AuthMiddleware();
  const auditMiddleware = new AuditMiddleware();

  const limiterFactory: AuthLimiterFactory =
    deps.limiterFactory ??
    (opts => {
      if (!deps.redisClient) {
        throw new Error(
          'createAuthRouter: redisClient is required when limiterFactory is not supplied'
        );
      }
      return createBucketLimiter(opts, {
        redis: deps.redisClient,
        ...(deps.log ? { log: deps.log } : {}),
      });
    });

  // Per-bucket limiters, mounted exactly once each. Re-using the same
  // limiter across multiple routes is intentional — `express-rate-limit`
  // bookkeeping per limiter is keyed off the request, not the route, so
  // there is no cross-route accounting bug.
  const authLimiter = limiterFactory({
    bucket: 'auth',
    windowMs: AUTH_LIMITER_WINDOWS.auth.windowMs,
    max: AUTH_LIMITER_WINDOWS.auth.max,
    message: 'Too many authentication attempts',
  });
  const passwordResetLimiter = limiterFactory({
    bucket: 'password-reset',
    windowMs: AUTH_LIMITER_WINDOWS['password-reset'].windowMs,
    max: AUTH_LIMITER_WINDOWS['password-reset'].max,
    message: 'Too many password-reset attempts',
  });
  const mfaLimiter = limiterFactory({
    bucket: 'mfa',
    windowMs: AUTH_LIMITER_WINDOWS.mfa.windowMs,
    max: AUTH_LIMITER_WINDOWS.mfa.max,
    message: 'Too many MFA attempts',
  });

  // -------------------------------------------------------------------------
  // Public routes
  // -------------------------------------------------------------------------

  router.post(
    '/register',
    authLimiter,
    auditMiddleware.auditUserAction('register', 'user'),
    [
      body('username')
        .isLength({ min: 3, max: 50 })
        .matches(/^[a-zA-Z0-9_-]+$/)
        .withMessage(
          'Username must be 3-50 characters and contain only letters, numbers, underscores, and hyphens'
        ),
      body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
      body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long'),
      body('firstName')
        .notEmpty()
        .isLength({ max: 50 })
        .withMessage(
          'First name is required and must be 50 characters or less'
        ),
      body('lastName')
        .notEmpty()
        .isLength({ max: 50 })
        .withMessage('Last name is required and must be 50 characters or less'),
      body('agreeToTerms')
        .isBoolean()
        .custom(value => value === true)
        .withMessage('You must agree to the terms and conditions'),
    ],
    authController.register
  );

  router.post(
    '/login',
    authLimiter,
    auditMiddleware.auditUserAction('login', 'session'),
    [
      body('username').notEmpty().withMessage('Username or email is required'),
      body('password').notEmpty().withMessage('Password is required'),
      body('mfaCode')
        .optional()
        .isLength({ min: 6, max: 6 })
        .isNumeric()
        .withMessage('MFA code must be 6 digits'),
      body('rememberMe')
        .optional()
        .isBoolean()
        .withMessage('Remember me must be a boolean'),
    ],
    authController.login
  );

  router.post('/refresh', authLimiter, authController.refreshToken);

  router.post(
    '/password-reset',
    passwordResetLimiter,
    auditMiddleware.auditUserAction('request_password_reset', 'user'),
    [
      body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
    ],
    authController.requestPasswordReset
  );

  router.post(
    '/password-reset/confirm',
    passwordResetLimiter,
    auditMiddleware.auditUserAction('confirm_password_reset', 'user'),
    [
      body('token').notEmpty().withMessage('Reset token is required'),
      body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long'),
      body('confirmPassword').custom((value, { req }) => {
        if (value !== req.body.newPassword) {
          throw new Error('Password confirmation does not match');
        }
        return true;
      }),
    ],
    authController.confirmPasswordReset
  );

  router.get(
    '/verify-email',
    auditMiddleware.auditUserAction('verify_email', 'user'),
    [query('token').notEmpty().withMessage('Verification token is required')],
    authController.verifyEmail
  );

  router.get('/health', authController.healthCheck);

  // -------------------------------------------------------------------------
  // Protected routes
  // -------------------------------------------------------------------------

  router.use(authMiddleware.authenticate);

  router.get(
    '/profile',
    auditMiddleware.auditUserAction('read_profile', 'user'),
    authController.getProfile
  );

  router.post(
    '/logout',
    auditMiddleware.auditUserAction('logout', 'session'),
    authController.logout
  );

  router.post(
    '/change-password',
    passwordResetLimiter,
    auditMiddleware.auditUserAction('change_password', 'user'),
    [
      body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
      body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long'),
      body('confirmPassword').custom((value, { req }) => {
        if (value !== req.body.newPassword) {
          throw new Error('Password confirmation does not match');
        }
        return true;
      }),
    ],
    authController.changePassword
  );

  router.post(
    '/mfa/setup',
    mfaLimiter,
    auditMiddleware.auditUserAction('setup_mfa', 'user'),
    [
      body('method')
        .isIn(['totp', 'sms', 'email'])
        .withMessage('MFA method must be one of: totp, sms, email'),
      body('phoneNumber')
        .if(body('method').equals('sms'))
        .isMobilePhone('any')
        .withMessage('Valid phone number is required for SMS MFA'),
      body('emailAddress')
        .if(body('method').equals('email'))
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email address is required for email MFA'),
    ],
    authController.setupMFA
  );

  router.post(
    '/mfa/verify',
    mfaLimiter,
    auditMiddleware.auditUserAction('verify_mfa', 'user'),
    [
      body('code')
        .isLength({ min: 6, max: 6 })
        .isNumeric()
        .withMessage('MFA code must be 6 digits'),
      body('method')
        .isIn(['totp', 'sms', 'email', 'backup'])
        .withMessage('MFA method is required'),
      body('backupCode')
        .optional()
        .isLength({ min: 8, max: 8 })
        .matches(/^[A-Z0-9]+$/)
        .withMessage('Backup code must be 8 alphanumeric characters'),
    ],
    authController.verifyMFA
  );

  // Admin-only routes
  router.use(authMiddleware.requireRole('admin'));

  router.get(
    '/metrics',
    auditMiddleware.auditUserAction('read_metrics', 'admin'),
    authController.getMetrics
  );

  router.get(
    '/rate-limit',
    auditMiddleware.auditUserAction('read_rate_limit', 'admin'),
    authController.getRateLimitStatus
  );

  // Router-scoped error handler: keeps payload errors visible without
  // leaking stack traces.
  router.use(
    (
      error: Error & { type?: string },
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction
    ) => {
      if (error.type === 'entity.parse.failed') {
        res.status(400).json({
          success: false,
          error: 'Invalid JSON in request body',
        });
        return;
      }
      if (error.type === 'entity.too.large') {
        res.status(413).json({
          success: false,
          error: 'Request body too large',
        });
        return;
      }
      (deps.log ?? logger).error('Auth route error', {
        message: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  );

  return router;
}
