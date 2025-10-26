import request from 'supertest';
import { Express } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../../src/app';
import { UserModel, RoleModel, PermissionModel } from '../../src/models';
import { UserStatus } from '../../src/types/auth.types';

describe('Authentication Integration Tests', () => {
  let app: Express;
  let mongoServer: MongoMemoryServer;
  let server: any;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    app = createApp();
    server = app.listen(0); // Use random port for testing
  });

  afterAll(async () => {
    await server.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await RoleModel.deleteMany({});
    await PermissionModel.deleteMany({});
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      const response = await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user.username).toBe(userData.username);
      expect(response.body.data.user.email).toBe(userData.email);
      expect(response.body.data.user.emailVerified).toBe(false);
      expect(response.body.data.requiresVerification).toBe(true);

      // Verify user was created in database
      const user = await UserModel.findOne({ username: userData.username });
      expect(user).toBeTruthy();
      expect(user?.email).toBe(userData.email);
    });

    it('should reject registration with invalid data', async () => {
      const userData = {
        username: 'ab', // Too short
        email: 'invalid-email',
        password: 'weak', // Too weak
        firstName: '',
        lastName: '',
        agreeToTerms: false
      };

      const response = await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toBeDefined();
    });

    it('should reject registration with duplicate username', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      // First registration should succeed
      await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      // Second registration with same username should fail
      const duplicateData = {
        ...userData,
        email: 'different@example.com'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(duplicateData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('already exists');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Create a test user
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await request(app)
        .post('/auth/register')
        .send(userData);

      // Verify and activate the user
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

      const response = await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user.username).toBe('testuser');
      expect(response.body.data.tokens.accessToken).toBeDefined();
      expect(response.body.data.tokens.refreshToken).toBeDefined();
      expect(response.body.data.requiresMFA).toBe(false);

      // Check for secure cookies
      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('accessToken=');
      expect(response.headers['set-cookie'][1]).toContain('refreshToken=');
    });

    it('should reject login with incorrect password', async () => {
      const loginData = {
        username: 'testuser',
        password: 'wrongpassword'
      };

      const response = await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid credentials');
    });

    it('should reject login with non-existent user', async () => {
      const loginData = {
        username: 'nonexistent',
        password: 'password'
      };

      const response = await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid credentials');
    });

    it('should handle rate limiting for repeated failed attempts', async () => {
      const loginData = {
        username: 'testuser',
        password: 'wrongpassword'
      };

      // Make multiple failed attempts
      for (let i = 0; i < 6; i++) {
        await request(app)
          .post('/auth/login')
          .send(loginData);
      }

      // Next attempt should be rate limited
      const response = await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(429);

      expect(response.body.error).toContain('Too many requests');
    });
  });

  describe('GET /auth/profile', () => {
    let accessToken: string;

    beforeEach(async () => {
      // Create and login a user
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await request(app)
        .post('/auth/register')
        .send(userData);

      // Verify and activate the user
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }

      // Login to get token
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'SecurePass123!'
        });

      accessToken = loginResponse.body.data.tokens.accessToken;
    });

    it('should get user profile with valid token', async () => {
      const response = await request(app)
        .get('/auth/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user.username).toBe('testuser');
      expect(response.body.data.user.email).toBe('test@example.com');
    });

    it('should reject profile request without token', async () => {
      const response = await request(app)
        .get('/auth/profile')
        .expect(401);

      expect(response.body.error).toContain('Authentication required');
    });

    it('should reject profile request with invalid token', async () => {
      const response = await request(app)
        .get('/auth/profile')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.error).toContain('Invalid or expired token');
    });
  });

  describe('POST /auth/logout', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      // Create and login a user
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await request(app)
        .post('/auth/register')
        .send(userData);

      // Verify and activate the user
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }

      // Login to get tokens
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'SecurePass123!'
        });

      accessToken = loginResponse.body.data.tokens.accessToken;
      refreshToken = loginResponse.body.data.tokens.refreshToken;
    });

    it('should logout user successfully', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('successful');

      // Verify cookies are cleared
      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('accessToken=;');
      expect(response.headers['set-cookie'][1]).toContain('refreshToken=;');
    });

    it('should reject logout without authentication', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .expect(401);

      expect(response.body.error).toContain('Authentication required');
    });
  });

  describe('POST /auth/change-password', () => {
    let accessToken: string;

    beforeEach(async () => {
      // Create and login a user
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await request(app)
        .post('/auth/register')
        .send(userData);

      // Verify and activate the user
      const user = await UserModel.findOne({ username: 'testuser' });
      if (user) {
        user.emailVerified = true;
        user.status = UserStatus.ACTIVE;
        await user.save();
      }

      // Login to get token
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'SecurePass123!'
        });

      accessToken = loginResponse.body.data.tokens.accessToken;
    });

    it('should change password successfully', async () => {
      const passwordData = {
        currentPassword: 'SecurePass123!',
        newPassword: 'NewSecurePass456!',
        confirmPassword: 'NewSecurePass456!'
      };

      const response = await request(app)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(passwordData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('successfully');

      // Verify old password no longer works
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'SecurePass123!'
        })
        .expect(401);

      expect(loginResponse.body.error).toContain('Invalid credentials');

      // Verify new password works
      const newLoginResponse = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'NewSecurePass456!'
        })
        .expect(200);

      expect(newLoginResponse.body.success).toBe(true);
    });

    it('should reject password change with incorrect current password', async () => {
      const passwordData = {
        currentPassword: 'wrongpassword',
        newPassword: 'NewSecurePass456!',
        confirmPassword: 'NewSecurePass456!'
      };

      const response = await request(app)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(passwordData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Current password is incorrect');
    });

    it('should reject password change with weak new password', async () => {
      const passwordData = {
        currentPassword: 'SecurePass123!',
        newPassword: 'weak',
        confirmPassword: 'weak'
      };

      const response = await request(app)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(passwordData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('security requirements');
    });
  });

  describe('POST /auth/password-reset', () => {
    beforeEach(async () => {
      // Create a test user
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!',
        firstName: 'Test',
        lastName: 'User',
        agreeToTerms: true
      };

      await request(app)
        .post('/auth/register')
        .send(userData);
    });

    it('should request password reset successfully', async () => {
      const resetData = {
        email: 'test@example.com'
      };

      const response = await request(app)
        .post('/auth/password-reset')
        .send(resetData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('sent');
    });

    it('should handle password reset for non-existent email gracefully', async () => {
      const resetData = {
        email: 'nonexistent@example.com'
      };

      const response = await request(app)
        .post('/auth/password-reset')
        .send(resetData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('sent');
    });

    it('should reject password reset with invalid email', async () => {
      const resetData = {
        email: 'invalid-email'
      };

      const response = await request(app)
        .post('/auth/password-reset')
        .send(resetData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Validation failed');
    });
  });

  describe('GET /auth/health', () => {
    it('should return healthy status', async () => {
      const response = await request(app)
        .get('/auth/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('healthy');
    });
  });

  describe('Security Headers', () => {
    it('should include security headers', async () => {
      const response = await request(app)
        .get('/auth/health')
        .expect(200);

      // Check for common security headers
      expect(response.headers).toBeDefined();
      // Additional header checks would depend on the security middleware implementation
    });
  });

  describe('CORS', () => {
    it('should handle CORS preflight requests', async () => {
      const response = await request(app)
        .options('/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Rate Limiting Headers', () => {
    it('should include rate limiting headers', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          username: 'nonexistent',
          password: 'wrongpassword'
        })
        .expect(401);

      // Check for rate limiting headers
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });
  });
});