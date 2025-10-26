import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { config } from '../../config';
import { MFASetupResponse, MFAVerificationRequest } from '../../types/auth.types';
import logger from '../logger';

export class MFAService {
  private readonly issuer: string;

  constructor() {
    this.issuer = config.app.name;
  }

  async setupTOTP(userId: string): Promise<MFASetupResponse> {
    try {
      const secret = speakeasy.generateSecret({
        name: `${this.issuer} (${userId})`,
        issuer: this.issuer,
        length: 32
      });

      // Generate QR code
      const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      logger.info('TOTP setup initiated', { userId });

      return {
        secret: secret.base32,
        qrCode: qrCodeUrl,
        backupCodes,
        verificationRequired: true
      };
    } catch (error) {
      logger.error('Failed to setup TOTP', { error, userId });
      throw new Error('Failed to setup TOTP');
    }
  }

  async setupSMS(userId: string, phoneNumber: string): Promise<MFASetupResponse> {
    try {
      // Generate verification code
      const verificationCode = this.generateSMSCode();

      // In a real implementation, you would send this via SMS service
      logger.info('SMS MFA setup initiated', { userId, phoneNumber });

      return {
        verificationRequired: true,
        // In a real implementation, you might return a reference ID instead of the code
      };
    } catch (error) {
      logger.error('Failed to setup SMS MFA', { error, userId });
      throw new Error('Failed to setup SMS MFA');
    }
  }

  async setupEmail(userId: string, emailAddress: string): Promise<MFASetupResponse> {
    try {
      // Generate verification code
      const verificationCode = this.generateEmailCode();

      // In a real implementation, you would send this via email service
      logger.info('Email MFA setup initiated', { userId, emailAddress });

      return {
        verificationRequired: true,
        // In a real implementation, you might return a reference ID instead of the code
      };
    } catch (error) {
      logger.error('Failed to setup Email MFA', { error, userId });
      throw new Error('Failed to setup Email MFA');
    }
  }

  async verifyCode(userId: string, code: string, isBackupCode: boolean = false): Promise<boolean> {
    try {
      if (isBackupCode) {
        return this.verifyBackupCode(userId, code);
      }

      // In a real implementation, you would retrieve the user's MFA secret from the database
      // and verify the code against it
      const secret = await this.getUserMFASecret(userId);
      if (!secret) {
        logger.warn('No MFA secret found for user', { userId });
        return false;
      }

      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 2, // Allow 2 windows before and after for clock drift
        time: Math.floor(Date.now() / 1000)
      });

      logger.info('MFA verification attempt', { userId, verified, isBackupCode });

      return verified;
    } catch (error) {
      logger.error('Failed to verify MFA code', { error, userId });
      return false;
    }
  }

  async verifySMSCode(userId: string, code: string): Promise<boolean> {
    try {
      // In a real implementation, you would verify the SMS code sent to the user
      // This would involve checking the code against what was sent via SMS service
      logger.info('SMS MFA verification attempt', { userId });

      // Mock verification - in reality, this would check against the sent code
      return code.length === 6 && /^\d{6}$/.test(code);
    } catch (error) {
      logger.error('Failed to verify SMS code', { error, userId });
      return false;
    }
  }

  async verifyEmailCode(userId: string, code: string): Promise<boolean> {
    try {
      // In a real implementation, you would verify the email code sent to the user
      // This would involve checking the code against what was sent via email service
      logger.info('Email MFA verification attempt', { userId });

      // Mock verification - in reality, this would check against the sent code
      return code.length === 6 && /^\d{6}$/.test(code);
    } catch (error) {
      logger.error('Failed to verify email code', { error, userId });
      return false;
    }
  }

  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push(this.generateBackupCode());
    }
    return codes;
  }

  private generateBackupCode(): string {
    return speakeasy.generateSecret({ length: 8 }).base32.substring(0, 8).toUpperCase();
  }

  private verifyBackupCode(userId: string, code: string): Promise<boolean> {
    // In a real implementation, you would check the backup code against
    // the stored backup codes for the user and mark it as used if valid
    logger.info('Backup code verification attempt', { userId });
    return Promise.resolve(false); // Mock implementation
  }

  private generateSMSCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private generateEmailCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private async getUserMFASecret(userId: string): Promise<string | null> {
    // In a real implementation, you would retrieve the MFA secret from the database
    // This is a mock implementation
    return null;
  }

  async disableMFA(userId: string): Promise<void> {
    try {
      // In a real implementation, you would disable MFA for the user
      // This would involve removing the MFA secret and backup codes
      logger.info('MFA disabled for user', { userId });
    } catch (error) {
      logger.error('Failed to disable MFA', { error, userId });
      throw new Error('Failed to disable MFA');
    }
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    try {
      const newBackupCodes = this.generateBackupCodes();

      // In a real implementation, you would store these new backup codes
      // in the database, replacing the old ones
      logger.info('Backup codes regenerated', { userId });

      return newBackupCodes;
    } catch (error) {
      logger.error('Failed to regenerate backup codes', { error, userId });
      throw new Error('Failed to regenerate backup codes');
    }
  }

  async getMFAStatus(userId: string): Promise<{
    enabled: boolean;
    methods: Array<{
      type: 'totp' | 'sms' | 'email';
      enabled: boolean;
      verified: boolean;
      lastUsed?: Date;
    }>;
  }> {
    try {
      // In a real implementation, you would retrieve the MFA status from the database
      return {
        enabled: false,
        methods: [
          { type: 'totp', enabled: false, verified: false },
          { type: 'sms', enabled: false, verified: false },
          { type: 'email', enabled: false, verified: false }
        ]
      };
    } catch (error) {
      logger.error('Failed to get MFA status', { error, userId });
      throw new Error('Failed to get MFA status');
    }
  }

  async validateMFASetup(userId: string, method: string, secret?: string): Promise<boolean> {
    try {
      switch (method) {
        case 'totp':
          if (!secret) {
            return false;
          }
          // Verify that the TOTP secret is valid by checking a test code
          const testCode = speakeasy.totp({
            secret,
            encoding: 'base32',
            time: Math.floor(Date.now() / 1000)
          });
          return speakeasy.totp.verify({
            secret,
            encoding: 'base32',
            token: testCode,
            window: 0
          });
        case 'sms':
        case 'email':
          // For SMS and email, verification would happen during the setup process
          return true;
        default:
          return false;
      }
    } catch (error) {
      logger.error('Failed to validate MFA setup', { error, userId, method });
      return false;
    }
  }
}