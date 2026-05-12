import { BaseService } from './base.service';
import {
  User,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  UserProfile,
  JWTTokenPair,
  AuthTokens,
  MFASetupRequest,
  MFASetupResponse,
  MFAVerificationRequest,
  PasswordChangeRequest,
  PasswordResetRequest,
  PasswordResetConfirmRequest,
  SecurityEvent,
  SecurityEventType,
  SecurityEventSeverity,
  UserStatus,
  AuthenticationMetrics,
} from '../types/auth.types';
import {
  UserModel,
  RoleModel,
  PermissionModel,
  SessionModel,
  SecurityEventModel,
} from '../models';
import logger from '../utils/logger';
import {
  JWTManager,
  MFAService,
  PasswordService,
  DeviceFingerprintService,
  EmailService,
} from '../utils/auth';
import type { RedisLike } from '../utils/auth/jwt.manager';
import type { MFARedisClient } from '../utils/auth/mfa.service';
import {
  compose,
  SystemClock,
  type Clock,
  type DomainEvent,
  type EventBus,
} from '../shared/kernel';
import { v4 as uuidv4 } from 'uuid';

/**
 * Dependency-injection envelope for {@link AuthService}.
 *
 * Every collaborator is optional so legacy callers (`new AuthService()`)
 * keep working. The composition root in `src/app.ts` passes a fully
 * wired bundle (`eventBus`, `jwtManager`, `mfaService`, shared Redis,
 * etc.) so the Redis-backed JWT denylist (ADR-0006) and the per-user
 * MFA challenge keys (ADR-0009) are reached on real requests.
 */
export interface AuthServiceDeps {
  /** Optional EventBus. When supplied, IAM domain events are published. */
  eventBus?: EventBus;
  /** Clock used for DomainEvent `occurredAt`. Defaults to `SystemClock`. */
  eventClock?: Clock;
  /** Pre-built JWT manager (lets the composition root share one bus). */
  jwtManager?: JWTManager;
  /**
   * Pre-built MFA service. When omitted but `redis` is supplied the
   * constructor synthesises one wired with the shared Redis client and
   * the supplied password service as the Argon2id hasher.
   */
  mfaService?: MFAService;
  /** Pre-built password service (also doubles as the MFA backup-code hasher). */
  passwordService?: PasswordService;
  /** Pre-built email service. */
  emailService?: EmailService;
  /** Pre-built device fingerprint service. */
  deviceFingerprintService?: DeviceFingerprintService;
  /**
   * Shared Redis client. When supplied, it is threaded into the JWT
   * denylist (ADR-0006) and the MFA challenge namespace (ADR-0009)
   * when those collaborators are constructed lazily.
   */
  redis?: RedisLike & MFARedisClient;
}

export class AuthService extends BaseService {
  private jwtManager: JWTManager;
  private mfaService: MFAService;
  private passwordService: PasswordService;
  private deviceFingerprintService: DeviceFingerprintService;
  private emailService: EmailService;
  private eventBus: EventBus | undefined;
  private readonly eventClock: Clock;

  constructor(deps: AuthServiceDeps = {}) {
    super('AuthService');

    this.passwordService = deps.passwordService ?? new PasswordService();
    this.deviceFingerprintService =
      deps.deviceFingerprintService ?? new DeviceFingerprintService();
    this.emailService = deps.emailService ?? new EmailService();

    // JWT manager: prefer injected, else construct one — threading the
    // shared Redis client through so the denylist + family-state table
    // are actually wired (ADR-0006). When neither is supplied we fall
    // back to a bare manager, preserving the legacy `new AuthService()`
    // codepath used by unit tests.
    if (deps.jwtManager !== undefined) {
      this.jwtManager = deps.jwtManager;
    } else {
      const jwtOpts: ConstructorParameters<typeof JWTManager>[0] = {};
      if (deps.eventBus !== undefined) {
        jwtOpts.eventBus = deps.eventBus;
      }
      if (deps.redis !== undefined) {
        jwtOpts.redis = deps.redis;
      }
      this.jwtManager = new JWTManager(jwtOpts);
    }

    // MFA service: prefer injected, else construct one with the shared
    // Redis client and the PasswordService as hasher (ADR-0009). The
    // bare `new MFAService()` fallback only fires when neither `redis`
    // nor `mfaService` is supplied — that keeps the legacy boot path
    // working but the in-memory MFA store warns once.
    if (deps.mfaService !== undefined) {
      this.mfaService = deps.mfaService;
    } else if (deps.redis !== undefined) {
      this.mfaService = new MFAService({
        redis: deps.redis,
        hasher: this.passwordService,
        ...(deps.eventBus !== undefined
          ? {
              eventBus: {
                publish: (
                  type: string,
                  payload: Record<string, unknown>
                ): void => {
                  // Bridge MFAService's narrow event shape onto the
                  // platform's DomainEvent envelope so the audit
                  // subscriber sees a normal `iam.mfa.*` event.
                  this.publishIam(
                    type,
                    'user',
                    String(payload['userId'] ?? ''),
                    payload
                  );
                },
              },
            }
          : {}),
      });
    } else {
      this.mfaService = new MFAService();
    }

    if (deps.eventBus !== undefined) {
      this.eventBus = deps.eventBus;
    }
    this.eventClock = deps.eventClock ?? new SystemClock();
  }

  /** Wire (or rewire) the EventBus. Threads down into the JWT manager. */
  setEventBus(bus: EventBus | undefined): void {
    this.eventBus = bus;
    this.jwtManager.setEventBus(bus);
  }

  /**
   * Read-only accessor: the JWT manager wired into this service.
   *
   * Exposed so the composition root / tests can assert that the
   * production wireup carried through and the Redis-backed denylist
   * (ADR-0006) is actually reached on real requests. Marked
   * intentionally as `getJwtManager` to discourage callers reaching
   * into a private field.
   */
  getJwtManager(): JWTManager {
    return this.jwtManager;
  }

  /** Read-only accessor: the MFAService wired into this service. */
  getMfaService(): MFAService {
    return this.mfaService;
  }

  /** Read-only accessor: the PasswordService wired into this service. */
  getPasswordService(): PasswordService {
    return this.passwordService;
  }

  async initialize(): Promise<void> {
    this.logOperation('Initializing authentication service');

    try {
      // Create default roles and permissions if they don't exist
      await this.createDefaultRolesAndPermissions();

      this.logOperation('Authentication service initialized successfully');
    } catch (error) {
      this.logOperation('Failed to initialize authentication service', error);
      throw error;
    }
  }

  async register(
    userData: RegisterRequest
  ): Promise<{ user: UserProfile; requiresVerification: boolean }> {
    return this.withErrorHandling(async () => {
      this.logOperation('Starting user registration', {
        username: userData.username,
        email: userData.email,
      });

      // Check if user already exists
      const existingUser = await UserModel.findOne({
        $or: [{ username: userData.username }, { email: userData.email }],
      });

      if (existingUser) {
        throw new Error('User with this username or email already exists');
      }

      // Validate password strength
      if (!this.passwordService.validatePasswordStrength(userData.password)) {
        throw new Error('Password does not meet security requirements');
      }

      // Get default user role
      const userRole = await RoleModel.findOne({ name: 'user' });
      if (!userRole) {
        throw new Error('Default user role not found');
      }

      // Create verification token
      const verificationToken = uuidv4();

      // Create new user
      const user = new UserModel({
        username: userData.username,
        email: userData.email,
        passwordHash: userData.password, // Will be hashed by pre-save middleware
        firstName: userData.firstName,
        lastName: userData.lastName,
        roles: [userRole._id],
        emailVerificationToken: verificationToken,
      });

      await user.save();

      // Send verification email
      try {
        await this.emailService.sendVerificationEmail(
          user.email,
          verificationToken
        );
      } catch (emailError) {
        logger.error('Failed to send verification email', {
          emailError,
          userId: user._id,
        });
      }

      // ADR-0018: publish iam.user.registered.
      const newUserId = String(user._id);
      this.publishIam<{ userId: string; email: string; username: string }>(
        'iam.user.registered',
        'user',
        newUserId,
        { userId: newUserId, email: user.email, username: user.username },
        newUserId
      );

      // Create security event
      await SecurityEventModel.createEvent(
        SecurityEventType.PASSWORD_CHANGE,
        'User account created',
        'registration',
        'auth-service',
        {
          userId: user._id,
          details: { username: user.username, email: user.email },
        }
      );

      const userProfile = this.getUserProfile(user);

      this.logOperation('User registered successfully', { userId: user._id });

      return {
        user: userProfile,
        requiresVerification: !user.emailVerified,
      };
    }, 'User registration failed');
  }

  async login(loginRequest: LoginRequest): Promise<LoginResponse> {
    return this.withErrorHandling(async () => {
      this.logOperation('Starting user login', {
        username: loginRequest.username,
      });

      // Find user with password
      const user = await UserModel.findOne({
        $or: [
          { username: loginRequest.username },
          { email: loginRequest.username },
        ],
      })
        .select('+passwordHash +loginAttempts +lockedUntil')
        .populate('roles permissions');

      if (!user) {
        this.emitLoginFailed(loginRequest.username, 'user_not_found');
        await this.createSecurityEvent(
          SecurityEventType.LOGIN_FAILURE,
          'Login attempt with invalid username/email',
          loginRequest,
          { reason: 'user_not_found' }
        );
        throw new Error('Invalid credentials');
      }

      // Check if user is locked
      if (user.isLocked()) {
        this.emitLoginFailed(loginRequest.username, 'account_locked');
        await this.createSecurityEvent(
          SecurityEventType.LOGIN_FAILURE,
          'Login attempt on locked account',
          loginRequest,
          { userId: user._id, reason: 'account_locked' }
        );
        throw new Error('Account is temporarily locked');
      }

      // Check account status
      if (user.status !== UserStatus.ACTIVE) {
        this.emitLoginFailed(loginRequest.username, `status:${user.status}`);
        await this.createSecurityEvent(
          SecurityEventType.LOGIN_FAILURE,
          `Login attempt on ${user.status} account`,
          loginRequest,
          { userId: user._id, status: user.status }
        );
        throw new Error(`Account is ${user.status}`);
      }

      // Verify password
      const isPasswordValid = await user.comparePassword(loginRequest.password);
      if (!isPasswordValid) {
        await user.incrementLoginAttempts();

        // Lockout policy detection: increment crossed the threshold.
        if (user.isLocked()) {
          const lockedUntil = (user as { lockedUntil?: Date }).lockedUntil;
          this.publishIam<{ userId: string; lockedUntil?: string }>(
            'iam.account.locked',
            'user',
            String(user._id),
            {
              userId: String(user._id),
              ...(lockedUntil
                ? { lockedUntil: lockedUntil.toISOString() }
                : {}),
            },
            String(user._id)
          );
        }

        this.emitLoginFailed(loginRequest.username, 'invalid_password');
        await this.createSecurityEvent(
          SecurityEventType.LOGIN_FAILURE,
          'Login attempt with invalid password',
          loginRequest,
          { userId: user._id, loginAttempts: user.loginAttempts + 1 }
        );

        throw new Error('Invalid credentials');
      }

      // Reset login attempts on successful login
      await user.resetLoginAttempts();

      // Check if MFA is required
      if (user.mfaEnabled && !loginRequest.mfaCode) {
        return {
          user: this.getUserProfile(user),
          tokens: {} as AuthTokens,
          requiresMFA: true,
          mfaMethods: await this.getMFAMethods(user._id),
        };
      }

      // Verify MFA if provided
      if (user.mfaEnabled && loginRequest.mfaCode) {
        const mfaValid = await this.mfaService.verifyCode(
          user._id,
          loginRequest.mfaCode
        );
        if (!mfaValid) {
          this.publishIam<{
            userId: string;
            method: string;
            ipAddress: string;
          }>(
            'iam.mfa.verification_failed',
            'user',
            String(user._id),
            {
              userId: String(user._id),
              method: 'totp',
              ipAddress: 'unknown',
            },
            String(user._id)
          );
          await this.createSecurityEvent(
            SecurityEventType.MFA_VERIFICATION_FAILURE,
            'Invalid MFA code provided',
            loginRequest,
            { userId: user._id }
          );
          throw new Error('Invalid MFA code');
        }
      }

      // Create session
      const sessionId = uuidv4();
      const deviceFingerprint =
        loginRequest.deviceFingerprint ||
        this.deviceFingerprintService.generateFingerprint();

      const session = new SessionModel({
        userId: user._id,
        sessionId,
        deviceFingerprint,
        deviceInfo:
          this.deviceFingerprintService.extractDeviceInfo(loginRequest),
        ipAddress: '127.0.0.1', // Should be extracted from request
        userAgent: 'auth-service', // Should be extracted from request
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        mfaVerified: user.mfaEnabled,
      });

      await session.save();

      // Generate JWT tokens (also publishes `iam.session.opened`).
      const tokens = await this.generateTokens(user, sessionId);

      // Update user last login
      user.lastLogin = new Date();
      await user.save();

      // ADR-0018: explicit login-succeeded event in addition to the
      // session-opened event the JWT manager fires.
      const userIdString = String(user._id);
      this.publishIam<{ userId: string; sessionId: string }>(
        'iam.login.succeeded',
        'user',
        userIdString,
        { userId: userIdString, sessionId },
        userIdString
      );

      // Create security event
      await this.createSecurityEvent(
        SecurityEventType.LOGIN_SUCCESS,
        'User logged in successfully',
        loginRequest,
        {
          userId: user._id,
          sessionId,
          mfaVerified: user.mfaEnabled,
        }
      );

      const userProfile = this.getUserProfile(user);

      this.logOperation('User logged in successfully', {
        userId: user._id,
        sessionId,
      });

      return {
        user: userProfile,
        tokens,
        requiresMFA: false,
      };
    }, 'Login failed');
  }

  async logout(
    userId: string,
    sessionId: string,
    tokens?: { accessToken?: string; refreshToken?: string }
  ): Promise<void> {
    return this.withErrorHandling(async () => {
      this.logOperation('Starting user logout', { userId, sessionId });

      // Revoke session
      const session = await SessionModel.findOne({
        userId,
        sessionId,
        isActive: true,
      });
      if (session) {
        await session.revoke();
      }

      // Denylist whichever tokens the controller forwarded. The manager
      // publishes `iam.token.revoked` per call (ADR-0018) and swallows
      // Redis errors so a logout still returns cleanly.
      // ADR-0006: presenting either of these tokens after this point
      // will be rejected by the verification middleware. The refresh
      // token additionally marks the family revoked, which fires
      // `iam.session.closed` from the JWT manager.
      try {
        if (tokens?.accessToken) {
          await this.jwtManager.revokeToken(tokens.accessToken, 'logout', {
            userId,
          });
        }
        if (tokens?.refreshToken) {
          await this.jwtManager.revokeToken(tokens.refreshToken, 'logout', {
            userId,
          });
        }
      } catch (err) {
        // Per ADR-0006: log + continue; access token will expire naturally.
        // TODO: emit metric `noip_token_revoke_failed_total`.
        logger.error('Token revocation failed during logout', { err, userId });
      }

      // ADR-0018: also publish a single summary `iam.session.closed`
      // event so subscribers see one logout signal regardless of which
      // tokens (if any) were forwarded.
      this.publishIam<{ userId: string; sessionId: string; reason: string }>(
        'iam.session.closed',
        'session',
        sessionId,
        { userId, sessionId, reason: 'logout' },
        userId
      );

      // Create security event
      await SecurityEventModel.createEvent(
        SecurityEventType.LOGOUT,
        'User logged out',
        'logout',
        'auth-service',
        { userId, sessionId }
      );

      this.logOperation('User logged out successfully', { userId, sessionId });
    }, 'Logout failed');
  }

  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    return this.withErrorHandling(async () => {
      this.logOperation('Refreshing token');

      // ADR-0006 rotation: the manager performs verification, denylist
      // check, theft detection (compromised-family marking), denylists
      // the consumed refresh, and issues a new pair under the SAME
      // family. We avoid double-verification this way.
      const rotated = await this.jwtManager.refreshToken(refreshToken);
      if (!rotated) {
        throw new Error('Invalid refresh token');
      }

      // Decode to learn the user/session for activity bookkeeping. The
      // manager has already verified — decode here is safe.
      const payload = await this.jwtManager.decodeToken(rotated.accessToken);
      if (!payload) {
        throw new Error('Invalid refresh token');
      }

      // Check if session exists and is active
      const session = await SessionModel.findOne({
        userId: payload.sub,
        sessionId: payload.sessionId,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        throw new Error('Session not found or expired');
      }

      // Get user
      const user = await UserModel.findById(payload.sub).populate(
        'roles permissions'
      );
      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new Error('User not found or inactive');
      }

      // Update session activity
      await session.updateLastActivity();

      this.logOperation('Token refreshed successfully', { userId: user._id });

      return {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        expiresIn: 15 * 60,
        tokenType: 'Bearer',
      };
    }, 'Token refresh failed');
  }

  async setupMFA(
    userId: string,
    setupRequest: MFASetupRequest
  ): Promise<MFASetupResponse> {
    return this.withErrorHandling(async () => {
      this.logOperation('Setting up MFA', {
        userId,
        method: setupRequest.method,
      });

      const user = await UserModel.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      let response: MFASetupResponse;

      switch (setupRequest.method) {
        case 'totp':
          response = await this.mfaService.setupTOTP(userId);
          break;
        case 'sms':
          if (!setupRequest.phoneNumber) {
            throw new Error('Phone number required for SMS MFA');
          }
          response = await this.mfaService.setupSMS(
            userId,
            setupRequest.phoneNumber
          );
          break;
        case 'email':
          if (!setupRequest.emailAddress) {
            throw new Error('Email address required for email MFA');
          }
          response = await this.mfaService.setupEmail(
            userId,
            setupRequest.emailAddress
          );
          break;
        default:
          throw new Error('Unsupported MFA method');
      }

      // ADR-0018: MFA setup (still requires verification before enabling).
      this.publishIam<{ userId: string; method: string }>(
        'iam.mfa.enrolment_started',
        'user',
        userId,
        { userId, method: setupRequest.method },
        userId
      );

      this.logOperation('MFA setup completed', {
        userId,
        method: setupRequest.method,
      });

      return response;
    }, 'MFA setup failed');
  }

  async verifyMFA(
    userId: string,
    verificationRequest: MFAVerificationRequest
  ): Promise<boolean> {
    return this.withErrorHandling(async () => {
      this.logOperation('Verifying MFA', {
        userId,
        method: verificationRequest.method,
      });

      const isValid = await this.mfaService.verifyCode(
        userId,
        verificationRequest.code,
        verificationRequest.backupCode
      );

      if (isValid) {
        this.publishIam<{ userId: string; method: string; sessionId: string }>(
          'iam.mfa.verification_success',
          'user',
          userId,
          { userId, method: verificationRequest.method, sessionId: '' },
          userId
        );
        await this.createSecurityEvent(
          SecurityEventType.MFA_VERIFICATION_SUCCESS,
          'MFA verification successful',
          'mfa-verification',
          'auth-service',
          { userId, method: verificationRequest.method }
        );
      } else {
        this.publishIam<{
          userId: string;
          method: string;
          ipAddress: string;
        }>(
          'iam.mfa.verification_failed',
          'user',
          userId,
          { userId, method: verificationRequest.method, ipAddress: 'unknown' },
          userId
        );
        await this.createSecurityEvent(
          SecurityEventType.MFA_VERIFICATION_FAILURE,
          'MFA verification failed',
          'mfa-verification',
          'auth-service',
          { userId, method: verificationRequest.method }
        );
      }

      return isValid;
    }, 'MFA verification failed');
  }

  async changePassword(
    userId: string,
    passwordRequest: PasswordChangeRequest
  ): Promise<void> {
    return this.withErrorHandling(async () => {
      this.logOperation('Changing password', { userId });

      const user = await UserModel.findById(userId).select('+passwordHash');
      if (!user) {
        throw new Error('User not found');
      }

      // Verify current password
      const isCurrentPasswordValid = await user.comparePassword(
        passwordRequest.currentPassword
      );
      if (!isCurrentPasswordValid) {
        throw new Error('Current password is incorrect');
      }

      // Validate new password strength
      if (
        !this.passwordService.validatePasswordStrength(
          passwordRequest.newPassword
        )
      ) {
        throw new Error('New password does not meet security requirements');
      }

      // Check if new password is different from current
      const isSamePassword = await user.comparePassword(
        passwordRequest.newPassword
      );
      if (isSamePassword) {
        throw new Error('New password must be different from current password');
      }

      // Update password
      user.passwordHash = passwordRequest.newPassword;
      await user.save();

      // Revoke all existing sessions except current
      // Implementation depends on session tracking. The chained
      // `iam.token.revoked` events surface there once we rip them out.

      // ADR-0018: publish iam.password.changed.
      this.publishIam<{ userId: string; by: string }>(
        'iam.password.changed',
        'user',
        userId,
        { userId, by: userId },
        userId
      );

      // Create security event
      await this.createSecurityEvent(
        SecurityEventType.PASSWORD_CHANGE,
        'User password changed',
        'password-change',
        'auth-service',
        { userId }
      );

      this.logOperation('Password changed successfully', { userId });
    }, 'Password change failed');
  }

  async requestPasswordReset(
    resetRequest: PasswordResetRequest
  ): Promise<void> {
    return this.withErrorHandling(async () => {
      this.logOperation('Requesting password reset', {
        email: resetRequest.email,
      });

      const user = await UserModel.findOne({ email: resetRequest.email });
      if (!user) {
        // Don't reveal that user doesn't exist
        return;
      }

      // Generate reset token
      const resetToken = user.generatePasswordResetToken();
      await user.save();

      // Send reset email
      try {
        await this.emailService.sendPasswordResetEmail(user.email, resetToken);
      } catch (emailError) {
        logger.error('Failed to send password reset email', {
          emailError,
          userId: user._id,
        });
      }

      // ADR-0018: publish iam.password.reset_requested.
      const resetUserId = String(user._id);
      this.publishIam<{ userId: string }>(
        'iam.password.reset_requested',
        'user',
        resetUserId,
        { userId: resetUserId },
        resetUserId
      );

      // Create security event
      await this.createSecurityEvent(
        SecurityEventType.PASSWORD_RESET,
        'Password reset requested',
        'password-reset',
        'auth-service',
        { userId: user._id }
      );

      this.logOperation('Password reset email sent', { userId: user._id });
    }, 'Password reset request failed');
  }

  async confirmPasswordReset(
    confirmRequest: PasswordResetConfirmRequest
  ): Promise<void> {
    return this.withErrorHandling(async () => {
      this.logOperation('Confirming password reset');

      // Hash the provided token to compare with stored hash
      const crypto = require('crypto');
      const hashedToken = crypto
        .createHash('sha256')
        .update(confirmRequest.token)
        .digest('hex');

      const user = await UserModel.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: new Date() },
      }).select('+passwordResetToken +passwordResetExpires');

      if (!user) {
        throw new Error('Invalid or expired reset token');
      }

      // Validate new password strength
      if (
        !this.passwordService.validatePasswordStrength(
          confirmRequest.newPassword
        )
      ) {
        throw new Error('New password does not meet security requirements');
      }

      // Update password
      user.passwordHash = confirmRequest.newPassword;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save();

      // Revoke all sessions
      await SessionModel.revokeAllByUser(user._id);

      // ADR-0018: publish iam.password.reset_confirmed.
      const confirmUserId = String(user._id);
      this.publishIam<{ userId: string }>(
        'iam.password.reset_confirmed',
        'user',
        confirmUserId,
        { userId: confirmUserId },
        confirmUserId
      );

      // Create security event
      await this.createSecurityEvent(
        SecurityEventType.PASSWORD_RESET,
        'Password reset completed',
        'password-reset',
        'auth-service',
        { userId: user._id }
      );

      this.logOperation('Password reset completed successfully', {
        userId: user._id,
      });
    }, 'Password reset confirmation failed');
  }

  async verifyEmail(token: string): Promise<void> {
    return this.withErrorHandling(async () => {
      this.logOperation('Verifying email');

      // Hash the provided token to compare with stored hash
      const crypto = require('crypto');
      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      const user = await UserModel.findOne({
        emailVerificationToken: hashedToken,
      }).select('+emailVerificationToken');

      if (!user) {
        throw new Error('Invalid verification token');
      }

      // Verify email
      user.emailVerified = true;
      user.emailVerificationToken = undefined;

      // Activate account if pending verification
      if (user.status === UserStatus.PENDING_VERIFICATION) {
        user.status = UserStatus.ACTIVE;
      }

      await user.save();

      // ADR-0018: publish iam.user.email_verified.
      const verifyUserId = String(user._id);
      this.publishIam<{ userId: string }>(
        'iam.user.email_verified',
        'user',
        verifyUserId,
        { userId: verifyUserId },
        verifyUserId
      );

      this.logOperation('Email verified successfully', { userId: user._id });
    }, 'Email verification failed');
  }

  async getProfile(userId: string): Promise<UserProfile> {
    return this.withErrorHandling(async () => {
      const user =
        await UserModel.findById(userId).populate('roles permissions');
      if (!user) {
        throw new Error('User not found');
      }

      return this.getUserProfile(user);
    }, 'Failed to get user profile');
  }

  async getAuthenticationMetrics(): Promise<AuthenticationMetrics> {
    return this.withErrorHandling(async () => {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const [
        totalUsers,
        activeUsers,
        activeSessions,
        loginStats,
        mfaStats,
        securityStats,
        lockedAccounts,
        passwordResets,
      ] = await Promise.all([
        UserModel.countDocuments(),
        UserModel.countDocuments({ status: UserStatus.ACTIVE }),
        SessionModel.countDocuments({
          isActive: true,
          expiresAt: { $gt: now },
        }),
        SecurityEventModel.countDocuments({
          type: {
            $in: [
              SecurityEventType.LOGIN_SUCCESS,
              SecurityEventType.LOGIN_FAILURE,
            ],
          },
          createdAt: { $gte: dayAgo },
        }),
        UserModel.countDocuments({ mfaEnabled: true }),
        SecurityEventModel.countDocuments({ createdAt: { $gte: dayAgo } }),
        UserModel.countDocuments({ lockedUntil: { $gt: now } }),
        SecurityEventModel.countDocuments({
          type: SecurityEventType.PASSWORD_RESET,
          createdAt: { $gte: dayAgo },
        }),
      ]);

      const successfulLogins = await SecurityEventModel.countDocuments({
        type: SecurityEventType.LOGIN_SUCCESS,
        createdAt: { $gte: dayAgo },
      });

      return {
        totalUsers,
        activeUsers,
        activeSessions,
        loginAttempts24h: loginStats,
        successfulLogins24h: successfulLogins,
        failedLogins24h: loginStats - successfulLogins,
        mfaAdoptionRate: totalUsers > 0 ? (mfaStats / totalUsers) * 100 : 0,
        securityEvents24h: securityStats,
        accountsLocked: lockedAccounts,
        passwordResets24h: passwordResets,
      };
    }, 'Failed to get authentication metrics');
  }

  private async generateTokens(
    user: any,
    sessionId: string
  ): Promise<AuthTokens> {
    // ADR-0006: a fresh `family` (UUID) is bound to both tokens at login
    // so a future refresh-replay can be detected and the family marked
    // compromised. The manager mints jti/family/iat/exp/iss/aud.
    const { accessToken, refreshToken } = await this.jwtManager.createTokenPair(
      {
        sub: user._id.toString(),
        username: user.username,
        email: user.email,
        roles: user.roles.map((role: any) => role.name),
        permissions: this.extractPermissions(user),
        sessionId,
      }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes
      tokenType: 'Bearer',
    };
  }

  private getUserProfile(user: any): UserProfile {
    return {
      id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
      permissions: user.permissions,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      lastLogin: user.lastLogin,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };
  }

  private extractPermissions(user: any): string[] {
    const permissions = new Set<string>();

    // Add direct permissions
    user.permissions?.forEach((permission: any) => {
      permissions.add(permission.name);
    });

    // Add permissions from roles
    user.roles?.forEach((role: any) => {
      role.permissions?.forEach((permission: any) => {
        permissions.add(permission.name);
      });
    });

    return Array.from(permissions);
  }

  private async getMFAMethods(userId: string): Promise<any[]> {
    // Implementation would return available MFA methods for the user
    return [
      {
        type: 'totp',
        name: 'Authenticator App',
        enabled: false,
        verified: false,
      },
      { type: 'sms', name: 'SMS', enabled: false, verified: false },
      { type: 'email', name: 'Email', enabled: false, verified: false },
    ];
  }

  private async createSecurityEvent(
    type: SecurityEventType,
    description: string,
    request: any,
    details: Record<string, any>
  ): Promise<void> {
    await SecurityEventModel.createEvent(
      type,
      description,
      '127.0.0.1', // Should be extracted from request
      'auth-service', // Should be extracted from request
      {
        severity: this.getEventSeverity(type),
        details,
      }
    );
  }

  private getEventSeverity(type: SecurityEventType): SecurityEventSeverity {
    switch (type) {
      case SecurityEventType.LOGIN_SUCCESS:
      case SecurityEventType.LOGOUT:
      case SecurityEventType.MFA_ENABLED:
        return SecurityEventSeverity.LOW;
      case SecurityEventType.LOGIN_FAILURE:
      case SecurityEventType.MFA_VERIFICATION_FAILURE:
      case SecurityEventType.PASSWORD_CHANGE:
        return SecurityEventSeverity.MEDIUM;
      case SecurityEventType.ACCOUNT_LOCKED:
      case SecurityEventType.SUSPICIOUS_LOGIN:
        return SecurityEventSeverity.HIGH;
      case SecurityEventType.PERMISSION_ESCALATION:
      case SecurityEventType.DATA_ACCESS:
        return SecurityEventSeverity.CRITICAL;
      default:
        return SecurityEventSeverity.MEDIUM;
    }
  }

  private async createDefaultRolesAndPermissions(): Promise<void> {
    this.logOperation('Creating default roles and permissions');

    // Create default permissions
    const defaultPermissions = [
      {
        name: 'user:read:own',
        resource: 'user',
        action: 'read',
        description: 'Read own user profile',
      },
      {
        name: 'user:update:own',
        resource: 'user',
        action: 'update',
        description: 'Update own user profile',
      },
      {
        name: 'admin:users:read',
        resource: 'admin',
        action: 'read',
        description: 'Read all users',
      },
      {
        name: 'admin:users:update',
        resource: 'admin',
        action: 'update',
        description: 'Update any user',
      },
      {
        name: 'admin:users:delete',
        resource: 'admin',
        action: 'delete',
        description: 'Delete any user',
      },
      {
        name: 'admin:security:read',
        resource: 'admin',
        action: 'read',
        description: 'Read security events',
      },
      {
        name: 'admin:system:read',
        resource: 'admin',
        action: 'read',
        description: 'Read system information',
      },
    ];

    for (const permData of defaultPermissions) {
      const existingPerm = await PermissionModel.findOne({
        name: permData.name,
      });
      if (!existingPerm) {
        await PermissionModel.createSystemPermission(
          permData.name,
          permData.resource,
          permData.action,
          permData.description
        );
      }
    }

    // Create default roles
    const defaultRoles = [
      {
        name: 'user',
        description: 'Default user role',
        permissions: ['user:read:own', 'user:update:own'],
      },
      {
        name: 'admin',
        description: 'Administrator role',
        permissions: [
          'admin:users:read',
          'admin:users:update',
          'admin:users:delete',
          'admin:security:read',
          'admin:system:read',
        ],
      },
      {
        name: 'super_admin',
        description: 'Super administrator role',
        permissions: [], // Will have all permissions
      },
    ];

    for (const roleData of defaultRoles) {
      const existingRole = await RoleModel.findOne({ name: roleData.name });
      if (!existingRole) {
        const permissions = await PermissionModel.find({
          name: { $in: roleData.permissions },
        });
        await RoleModel.createSystemRole(
          roleData.name,
          roleData.description,
          permissions.map(p => p._id)
        );
      }
    }

    this.logOperation('Default roles and permissions created');
  }

  async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      const metrics = await this.getAuthenticationMetrics();
      return {
        status: 'healthy',
        details: {
          activeUsers: metrics.activeUsers,
          activeSessions: metrics.activeSessions,
          uptime: process.uptime(),
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: (error as Error).message },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Domain event publishing (ADR-0018)
  // ---------------------------------------------------------------------------

  /**
   * Publishes a single IAM DomainEvent. No-ops when the bus has not been
   * wired (legacy boot path). Errors during publish are logged and
   * swallowed — never escape into the caller's request path.
   */
  private publishIam<T>(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: T,
    actorUserId?: string
  ): void {
    if (!this.eventBus) return;
    try {
      const envelope: Omit<
        DomainEvent<T>,
        'id' | 'occurredAt' | 'schemaVersion'
      > = {
        type,
        context: 'iam',
        aggregateType,
        aggregateId,
        payload,
        ...(actorUserId !== undefined
          ? { actor: { type: 'user' as const, id: actorUserId } }
          : {}),
      };
      const event = compose<T>(envelope, this.eventClock);
      this.eventBus.publish(event);
    } catch (err) {
      logger.error('Failed to publish iam domain event', {
        type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Convenience: publish `iam.login.failed` from any login-failure path. */
  private emitLoginFailed(
    usernameOrEmail: string,
    reason: string,
    ipAddress = 'unknown'
  ): void {
    this.publishIam<{
      usernameOrEmail: string;
      ipAddress: string;
      reason: string;
    }>('iam.login.failed', 'user', usernameOrEmail, {
      usernameOrEmail,
      ipAddress,
      reason,
    });
  }
}
