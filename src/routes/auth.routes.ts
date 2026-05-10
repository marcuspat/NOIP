import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { AuthMiddleware } from '../middleware/auth.middleware';
import { RateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { AuditMiddleware } from '../middleware/audit.middleware';
import { body, query } from 'express-validator';
import Redis from 'ioredis';
import { config } from '../config';

const router = Router();
const authController = new AuthController();
const authMiddleware = new AuthMiddleware();
const auditMiddleware = new AuditMiddleware();
const rateLimitMiddleware = new RateLimitMiddleware(
  new Redis(config.database.redis)
);

// Initialize auth service
authController.initialize();

// Public routes (no authentication required)

// User registration
router.post(
  '/register',
  rateLimitMiddleware.authRateLimit,
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
      .withMessage('First name is required and must be 50 characters or less'),
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

// User login
router.post(
  '/login',
  rateLimitMiddleware.authRateLimit,
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

// Refresh token
router.post(
  '/refresh',
  rateLimitMiddleware.rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 refresh attempts per 15 minutes
  }),
  authController.refreshToken
);

// Request password reset
router.post(
  '/password-reset',
  rateLimitMiddleware.passwordResetRateLimit,
  auditMiddleware.auditUserAction('request_password_reset', 'user'),
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
  ],
  authController.requestPasswordReset
);

// Confirm password reset
router.post(
  '/password-reset/confirm',
  rateLimitMiddleware.passwordResetRateLimit,
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

// Email verification
router.get(
  '/verify-email',
  auditMiddleware.auditUserAction('verify_email', 'user'),
  [query('token').notEmpty().withMessage('Verification token is required')],
  authController.verifyEmail
);

// Health check (public)
router.get('/health', authController.healthCheck);

// Protected routes (authentication required)

// Apply authentication middleware to all protected routes
router.use(authMiddleware.authenticate);

// Get current user profile
router.get(
  '/profile',
  auditMiddleware.auditUserAction('read_profile', 'user'),
  authController.getProfile
);

// Logout
router.post(
  '/logout',
  auditMiddleware.auditUserAction('logout', 'session'),
  authController.logout
);

// Change password
router.post(
  '/change-password',
  rateLimitMiddleware.rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 password changes per hour
  }),
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

// MFA setup
router.post(
  '/mfa/setup',
  rateLimitMiddleware.rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // 3 MFA setup attempts per 5 minutes
  }),
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

// MFA verification
router.post(
  '/mfa/verify',
  rateLimitMiddleware.mfaRateLimit,
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

// Get authentication metrics
router.get(
  '/metrics',
  auditMiddleware.auditUserAction('read_metrics', 'admin'),
  authController.getMetrics
);

// Get rate limit status
router.get(
  '/rate-limit',
  auditMiddleware.auditUserAction('read_rate_limit', 'admin'),
  authController.getRateLimitStatus
);

// Error handling middleware
router.use((error: any, req: any, res: any, next: any) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON in request body',
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Request body too large',
    });
  }

  // Log unexpected errors
  console.error('Auth route error:', error);

  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

export default router;
