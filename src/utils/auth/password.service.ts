import argon2 from 'argon2';
import crypto from 'crypto';
import logger from '../logger';

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecialChars: boolean;
  preventReuse: number;
  maxAge: number;
}

export class PasswordService {
  private readonly defaultPolicy: PasswordPolicy = {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
    preventReuse: 5,
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days in milliseconds
  };

  async hashPassword(password: string): Promise<string> {
    try {
      // argon2 v0.44+ no longer exposes a `saltLength` option; the library
      // generates a 16-byte salt internally if no `salt` Buffer is supplied,
      // which matches what we want here.
      const hash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536, // 64 MB
        timeCost: 3,
        parallelism: 4,
        hashLength: 32,
      });

      logger.debug('Password hashed successfully');
      return hash;
    } catch (error) {
      logger.error('Failed to hash password', { error });
      throw new Error('Password hashing failed');
    }
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      const isValid = await argon2.verify(hash, password);
      return isValid;
    } catch (error) {
      logger.error('Failed to verify password', { error });
      return false;
    }
  }

  validatePasswordStrength(
    password: string,
    policy?: Partial<PasswordPolicy>
  ): {
    isValid: boolean;
    errors: string[];
    score: number;
  } {
    const activePolicy = { ...this.defaultPolicy, ...policy };
    const errors: string[] = [];

    // Length check
    if (password.length < activePolicy.minLength) {
      errors.push(
        `Password must be at least ${activePolicy.minLength} characters long`
      );
    }

    // Uppercase check
    if (activePolicy.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    // Lowercase check
    if (activePolicy.requireLowercase && !/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    // Numbers check
    if (activePolicy.requireNumbers && !/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    // Special characters check
    if (
      activePolicy.requireSpecialChars &&
      !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
    ) {
      errors.push('Password must contain at least one special character');
    }

    // Common patterns check
    if (this.isCommonPassword(password)) {
      errors.push(
        'Password is too common. Please choose a more secure password'
      );
    }

    // Sequential characters check
    if (this.hasSequentialChars(password)) {
      errors.push('Password should not contain sequential characters');
    }

    // Repeated characters check
    if (this.hasRepeatedChars(password)) {
      errors.push('Password should not contain too many repeated characters');
    }

    const score = this.calculatePasswordScore(password);
    const isValid = errors.length === 0;

    return { isValid, errors, score };
  }

  generateSecurePassword(length: number = 16): string {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    const allChars = uppercase + lowercase + numbers + symbols;
    let password = '';

    // Ensure at least one character from each category
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += symbols[Math.floor(Math.random() * symbols.length)];

    // Fill the rest with random characters
    for (let i = 4; i < length; i++) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // Shuffle the password
    return password
      .split('')
      .sort(() => Math.random() - 0.5)
      .join('');
  }

  generatePasswordResetToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  hashPasswordResetToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  verifyPasswordResetToken(token: string, hashedToken: string): boolean {
    const hashedInput = this.hashPasswordResetToken(token);
    return hashedInput === hashedToken;
  }

  generateEmailVerificationToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  hashEmailVerificationToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  verifyEmailVerificationToken(token: string, hashedToken: string): boolean {
    const hashedInput = this.hashEmailVerificationToken(token);
    return hashedInput === hashedToken;
  }

  async checkPasswordExpiry(
    passwordChangedAt: Date,
    policy?: Partial<PasswordPolicy>
  ): Promise<boolean> {
    const activePolicy = { ...this.defaultPolicy, ...policy };
    const now = new Date();
    const expiryTime = passwordChangedAt.getTime() + activePolicy.maxAge;
    return now.getTime() > expiryTime;
  }

  async checkPasswordReuse(
    newPassword: string,
    passwordHistory: string[]
  ): Promise<boolean> {
    for (const oldPassword of passwordHistory) {
      if (await this.verifyPassword(newPassword, oldPassword)) {
        return true; // Password was reused
      }
    }
    return false;
  }

  private isCommonPassword(password: string): boolean {
    const commonPasswords = [
      'password',
      '123456',
      'password123',
      'admin',
      'qwerty',
      'letmein',
      'welcome',
      'monkey',
      '1234567890',
      'password1',
      'abc123',
      'password123!',
      'admin123',
      'root',
      'toor',
    ];

    const lowerPassword = password.toLowerCase();
    return commonPasswords.some(
      common => lowerPassword.includes(common) || common.includes(lowerPassword)
    );
  }

  private hasSequentialChars(password: string): boolean {
    // Check for sequential characters (both forward and backward)
    for (let i = 0; i < password.length - 2; i++) {
      const char1 = password.charCodeAt(i);
      const char2 = password.charCodeAt(i + 1);
      const char3 = password.charCodeAt(i + 2);

      // Forward sequence (abc, 123)
      if (char2 === char1 + 1 && char3 === char2 + 1) {
        return true;
      }

      // Backward sequence (cba, 321)
      if (char2 === char1 - 1 && char3 === char2 - 1) {
        return true;
      }
    }
    return false;
  }

  private hasRepeatedChars(password: string): boolean {
    // Check for too many repeated characters
    let consecutiveCount = 1;
    let maxConsecutive = 1;

    for (let i = 1; i < password.length; i++) {
      if (password[i] === password[i - 1]) {
        consecutiveCount++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
      } else {
        consecutiveCount = 1;
      }
    }

    return maxConsecutive > 3; // More than 3 consecutive same characters
  }

  private calculatePasswordScore(password: string): number {
    let score = 0;

    // Length contributes to score
    score += Math.min(password.length * 2, 20);

    // Character variety contributes to score
    if (/[a-z]/.test(password)) score += 5;
    if (/[A-Z]/.test(password)) score += 5;
    if (/\d/.test(password)) score += 5;
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score += 10;

    // Deduct points for common patterns
    if (this.isCommonPassword(password)) score -= 20;
    if (this.hasSequentialChars(password)) score -= 10;
    if (this.hasRepeatedChars(password)) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  getPasswordStrengthLabel(
    score: number
  ): 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong' {
    if (score < 30) return 'Weak';
    if (score < 50) return 'Fair';
    if (score < 70) return 'Good';
    if (score < 90) return 'Strong';
    return 'Very Strong';
  }

  getPasswordStrengthColor(score: number): string {
    if (score < 30) return '#ff4444'; // Red
    if (score < 50) return '#ff8800'; // Orange
    if (score < 70) return '#ffcc00'; // Yellow
    if (score < 90) return '#88dd00'; // Light Green
    return '#00cc44'; // Green
  }

  async migratePasswordHash(
    currentHash: string,
    plainPassword: string,
    _newHashingOptions?: unknown
  ): Promise<string> {
    // Check if the current hash uses an outdated algorithm
    const isOldHash = this.isOldPasswordHash(currentHash);

    if (isOldHash) {
      // Verify the password using the old hash first
      const isValid = await this.verifyPasswordWithOldHash(
        currentHash,
        plainPassword
      );
      if (isValid) {
        // Re-hash with the new algorithm
        return this.hashPassword(plainPassword);
      }
    }

    return currentHash;
  }

  private isOldPasswordHash(hash: string): boolean {
    // Check if hash uses outdated algorithm (e.g., bcrypt instead of argon2)
    return hash.startsWith('$2');
  }

  private async verifyPasswordWithOldHash(
    hash: string,
    password: string
  ): Promise<boolean> {
    // Implementation for verifying old password hashes
    // This would support legacy hashing algorithms during migration
    try {
      // For bcrypt hashes (starting with $2)
      if (hash.startsWith('$2')) {
        const bcrypt = require('bcryptjs');
        return bcrypt.compare(password, hash);
      }
      return false;
    } catch (error) {
      logger.error('Failed to verify password with old hash', { error });
      return false;
    }
  }
}
