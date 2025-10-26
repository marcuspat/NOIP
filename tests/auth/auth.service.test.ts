import { AuthService } from '../../src/services/auth.service';
import { UserModel, RoleModel, PermissionModel, SessionModel, SecurityEventModel } from '../../src/models';
import { UserStatus, SecurityEventType } from '../../src/types/auth.types';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

describe('AuthService', () => {
  let authService: AuthService;
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    authService = new AuthService();
    await authService.initialize();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await RoleModel.deleteMany({});
    await PermissionModel.deleteMany({});
    await SessionModel.deleteMany({});
    await SecurityEventModel.deleteMany({});
  });

  describe('User Registration', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      const result = await authService.register(userData);

      expect(result.user.username).toBe(userData.username);
      expect(result.user.email).toBe(userData.email);
      expect(result.user.firstName).toBe(userData.firstName);
      expect(result.user.lastName).toBe(userData.lastName);
      expect(result.user.emailVerified).toBe(false);
      expect(result.requiresVerification).toBe(true);
    });

    it('should reject registration with existing username', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      const duplicateUserData = {
        ...userData,
        email: 'different@example.com'
      };

      await expect(authService.register(duplicateUserData)).rejects.toThrow('User with this username or email already exists');
    });

    it('should reject registration with weak password', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'weak',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await expect(authService.register(userData)).rejects.toThrow('Password does not meet security requirements');
    });
  });

  describe('User Login', () => {
    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }
    });

    it('should login user successfully with correct credentials', async () => {
      const loginData = {
        username: 'testuser',
        password: 'SecurePass123!'
      };

      const result = await authService.login(loginData);

      expect(result.user.username).toBe('testuser');
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.requiresMFA).toBe(false);
    });

    it('should reject login with incorrect password', async () => {
      const loginData = {
        username: 'testuser',
        password: 'wrongpassword'
      };

      await expect(authService.login(loginData)).rejects.toThrow('Invalid credentials');
    });

    it('should reject login with non-existent user', async () => {
      const loginData = {
        username: 'nonexistent',
        password: 'password'
      };

      await expect(authService.login(loginData)).rejects.toThrow('Invalid credentials');
    });

    it('should handle login with MFA enabled', async () => {
      // Enable MFA for user
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.mfaEnabled = true;
        await user.save();
      }

      const loginData = {
        username: 'testuser',
        password: 'SecurePass123!'
      };

      const result = await authService.login(loginData);

      expect(result.requiresMFA).toBe(true);
      expect(result.mfaMethods).toBeDefined();
    });
  });

  describe('JWT Token Management', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email and activate
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }

      const loginData = {
        username: 'testuser',
        password: 'SecurePass123!'
      };

      const result = await authService.login(loginData);
      accessToken = result.tokens.accessToken;
      refreshToken = result.tokens.refreshToken;
    });

    it('should refresh tokens successfully', async () => {
      const result = await authService.refreshToken(refreshToken);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.accessToken).not.toBe(accessToken);
    });

    it('should reject refresh with invalid token', async () => {
      await expect(authService.refreshToken('invalid-token')).rejects.toThrow('Invalid refresh token');
    });
  });

  describe('Password Management', () => {
    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email and activate
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }
    });

    it('should change password successfully', async () => {
      const user = await UserModel.findOne({ username: 'testuser' });
      expect(user).toBeTruthy();

      const passwordData = {
        currentPassword: 'SecurePass123!',
        newPassword: 'NewSecurePass456!',
        confirmPassword: 'NewSecurePass456!'
      };

      await authService.changePassword(user!._id.toString(), passwordData);

      // Verify old password no longer works
      const loginData = {
        username: 'testuser',
        password: 'SecurePass123!'
      };

      await expect(authService.login(loginData)).rejects.toThrow('Invalid credentials');

      // Verify new password works
      const newLoginData = {
        username: 'testuser',
        password: 'NewSecurePass456!'
      };

      const result = await authService.login(newLoginData);
      expect(result.user.username).toBe('testuser');
    });

    it('should reject password change with incorrect current password', async () => {
      const user = await UserModel.findOne({ username: 'testuser' });
      expect(user).toBeTruthy();

      const passwordData = {
        currentPassword: 'wrongpassword',
        newPassword: 'NewSecurePass456!',
        confirmPassword: 'NewSecurePass456!'
      };

      await expect(authService.changePassword(user!._id.toString(), passwordData)).rejects.toThrow('Current password is incorrect');
    });

    it('should reject password change with weak new password', async () => {
      const user = await UserModel.findOne({ username: 'testuser' });
      expect(user).toBeTruthy();

      const passwordData = {
        currentPassword: 'SecurePass123!',
        newPassword: 'weak',
        confirmPassword: 'weak'
      };

      await expect(authService.changePassword(user!._id.toString(), passwordData)).rejects.toThrow('New password does not meet security requirements');
    });
  });

  describe('Password Reset', () => {
    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email and activate
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }
    });

    it('should request password reset successfully', async () => {
      const resetData = {
        email: 'test@example.com'
      };

      await expect(authService.requestPasswordReset(resetData)).resolves.not.toThrow();
    });

    it('should handle password reset for non-existent email gracefully', async () => {
      const resetData = {
        email: 'nonexistent@example.com'
      };

      await expect(authService.requestPasswordReset(resetData)).resolves.not.toThrow();
    });
  });

  describe('Email Verification', () => {
    let verificationToken: string;

    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Get verification token
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user && user.emailVerificationToken) {
        verificationToken = user.emailVerificationToken;
      }
    });

    it('should verify email successfully', async () => {
      await authService.verifyEmail(verificationToken);

      const user = await UserModel.findOne({ username: 'testuser' });
      expect(user?.emailVerified).toBe(true);
      expect(user?.status).toBe(UserStatus.ACTIVE);
    });

    it('should reject verification with invalid token', async () => {
      await expect(authService.verifyEmail('invalid-token')).rejects.toThrow('Invalid verification token');
    });
  });

  describe('User Profile', () => {
    beforeEach(async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email and activate
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }
    });

    it('should get user profile successfully', async () => {
      const user = await UserModel.findOne({ username: 'testuser' });
      expect(user).toBeTruthy();

      const profile = await authService.getProfile(user!._id.toString());

      expect(profile.username).toBe('testuser');
      expect(profile.email).toBe('test@example.com');
      expect(profile.firstName).toBe('Test');
      expect(profile.lastName).toBe('User');
    });

    it('should return null for non-existent user', async () => {
      await expect(authService.getProfile('507f1f77bcf86cd799439011')).rejects.toThrow('User not found');
    });
  });

  describe('Security Events', () => {
    it('should create security events for failed login attempts', async () => {
      const loginData = {
        username: 'nonexistent',
        password: 'wrongpassword'
      };

      try {
        await authService.login(loginData);
      } catch (error) {
        // Expected to fail
      }

      const events = await SecurityEventModel.find({
        type: SecurityEventType.LOGIN_FAILURE
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(SecurityEventType.LOGIN_FAILURE);
    });

    it('should create security events for successful login', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Verify email and activate
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }

      const loginData = {
        username: 'testuser',
        password: 'SecurePass123!'
      };

      await authService.login(loginData);

      const events = await SecurityEventModel.find({
        type: SecurityEventType.LOGIN_SUCCESS
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(SecurityEventType.LOGIN_SUCCESS);
    });
  });

  describe('Authentication Metrics', () => {
    beforeEach(async () => {
      // Create some test users
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await authService.register(userData);

      // Create another user
      const userData2 = {
        username: 'testuser2',
        email: 'test2@example.com',
        password: 'SecurePass123!',
        firstName: 'Test2',
        lastName: 'User2',
        agreeToTerms: true
      };

      await authService.register(userData2);
    });

    it('should return authentication metrics', async () => {
      const metrics = await authService.getAuthenticationMetrics();

      expect(metrics).toHaveProperty('totalUsers');
      expect(metrics).toHaveProperty('activeUsers');
      expect(metrics).toHaveProperty('activeSessions');
      expect(metrics).toHaveProperty('loginAttempts24h');
      expect(metrics).toHaveProperty('successfulLogins24h');
      expect(metrics).toHaveProperty('failedLogins24h');
      expect(metrics).toHaveProperty('mfaAdoptionRate');
      expect(metrics).toHaveProperty('securityEvents24h');
      expect(metrics).toHaveProperty('accountsLocked');
      expect(metrics).toHaveProperty('passwordResets24h');

      expect(metrics.totalUsers).toBeGreaterThanOrEqual(0);
      expect(metrics.activeUsers).toBeGreaterThanOrEqual(0);
      expect(metrics.mfaAdoptionRate).toBeGreaterThanOrEqual(0);
      expect(metrics.mfaAdoptionRate).toBeLessThanOrEqual(100);
    });
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const health = await authService.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.details).toBeDefined();
    });
  });
});