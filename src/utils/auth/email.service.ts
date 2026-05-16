import nodemailer from 'nodemailer';
import { config } from '../../config';
import logger from '../logger';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class EmailService {
  private transporter: nodemailer.Transporter;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor() {
    this.fromEmail =
      config.app.environment === 'production'
        ? 'noreply@noip.platform'
        : process.env['EMAIL_FROM'] || 'noreply@noip.local';
    this.fromName = 'NOIP Platform';

    this.transporter = nodemailer.createTransport({
      host: process.env['SMTP_HOST'] || 'localhost',
      port: parseInt(process.env['SMTP_PORT'] || '587'),
      secure: process.env['SMTP_SECURE'] === 'true',
      auth: {
        user: process.env['SMTP_USER'] || '',
        pass: process.env['SMTP_PASS'] || '',
      },
      tls: {
        rejectUnauthorized: process.env['SMTP_REJECT_UNAUTHORIZED'] !== 'false',
      },
    });

    this.verifyTransporter();
  }

  private async verifyTransporter(): Promise<void> {
    try {
      await this.transporter.verify();
      logger.info('Email service transporter verified successfully');
    } catch (error) {
      logger.error('Failed to verify email transporter', { error });
      // In development, we might not have a real SMTP server
      if (config.app.environment !== 'production') {
        logger.warn(
          'Email service running in development mode without SMTP verification'
        );
      }
    }
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    try {
      const mailOptions = {
        from: `${this.fromName} <${this.fromEmail}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || this.htmlToText(options.html),
      };

      const info = await this.transporter.sendMail(mailOptions);
      logger.info('Email sent successfully', {
        to: options.to,
        subject: options.subject,
        messageId: info.messageId,
      });
    } catch (error) {
      logger.error('Failed to send email', {
        error,
        to: options.to,
        subject: options.subject,
      });
      throw new Error(`Failed to send email: ${(error as Error).message}`);
    }
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verificationUrl = `${this.getBaseUrl()}/auth/verify-email?token=${token}`;
    const html = this.generateVerificationEmailTemplate(verificationUrl);
    const text = `Please verify your email address by clicking the following link: ${verificationUrl}`;

    await this.sendEmail({
      to: email,
      subject: 'Verify Your Email Address - NOIP Platform',
      html,
      text,
    });
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const resetUrl = `${this.getBaseUrl()}/auth/reset-password?token=${token}`;
    const html = this.generatePasswordResetEmailTemplate(resetUrl);
    const text = `To reset your password, please click the following link: ${resetUrl}`;

    await this.sendEmail({
      to: email,
      subject: 'Reset Your Password - NOIP Platform',
      html,
      text,
    });
  }

  async sendMFACodeEmail(email: string, code: string): Promise<void> {
    const html = this.generateMFACodeEmailTemplate(code);
    const text = `Your MFA verification code is: ${code}`;

    await this.sendEmail({
      to: email,
      subject: 'Your MFA Verification Code - NOIP Platform',
      html,
      text,
    });
  }

  async sendSecurityAlertEmail(
    email: string,
    event: {
      type: string;
      description: string;
      ipAddress: string;
      location?: string;
      timestamp: Date;
    }
  ): Promise<void> {
    const html = this.generateSecurityAlertEmailTemplate(event);
    const text = `Security Alert: ${event.description}. If this was not you, please secure your account immediately.`;

    await this.sendEmail({
      to: email,
      subject: 'Security Alert - NOIP Platform',
      html,
      text,
    });
  }

  async sendAccountLockedEmail(email: string, reason: string): Promise<void> {
    const html = this.generateAccountLockedEmailTemplate(reason);
    const text = `Your account has been locked due to: ${reason}. Please contact support if you believe this is an error.`;

    await this.sendEmail({
      to: email,
      subject: 'Account Locked - NOIP Platform',
      html,
      text,
    });
  }

  async sendWelcomeEmail(email: string, username: string): Promise<void> {
    const html = this.generateWelcomeEmailTemplate(username);
    const text = `Welcome to NOIP Platform, ${username}! Your account has been created successfully.`;

    await this.sendEmail({
      to: email,
      subject: 'Welcome to NOIP Platform!',
      html,
      text,
    });
  }

  private getBaseUrl(): string {
    if (config.app.environment === 'production') {
      return process.env['BASE_URL'] || 'https://noip.platform';
    } else {
      return process.env['BASE_URL'] || 'http://localhost:3000';
    }
  }

  private generateVerificationEmailTemplate(verificationUrl: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .code { background: #e5e7eb; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Verify Your Email Address</h1>
        </div>
        <div class="content">
          <p>Thank you for signing up for NOIP Platform! To complete your registration, please verify your email address by clicking the button below:</p>

          <div style="text-align: center;">
            <a href="${verificationUrl}" class="button">Verify Email Address</a>
          </div>

          <p>Or copy and paste this link into your browser:</p>
          <div class="code">${verificationUrl}</div>

          <p><strong>Note:</strong> This verification link will expire in 24 hours.</p>

          <p>If you didn't create an account with NOIP Platform, you can safely ignore this email.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generatePasswordResetEmailTemplate(resetUrl: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc2626; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fef2f2; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .code { background: #fecaca; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
          .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Reset Your Password</h1>
        </div>
        <div class="content">
          <p>We received a request to reset your password for your NOIP Platform account. Click the button below to reset your password:</p>

          <div style="text-align: center;">
            <a href="${resetUrl}" class="button">Reset Password</a>
          </div>

          <p>Or copy and paste this link into your browser:</p>
          <div class="code">${resetUrl}</div>

          <div class="warning">
            <p><strong>Security Notice:</strong> This password reset link will expire in 10 minutes for your security.</p>
          </div>

          <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generateMFACodeEmailTemplate(code: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your MFA Verification Code</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #059669; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #ecfdf5; padding: 30px; border-radius: 0 0 8px 8px; }
          .code-box { background: #059669; color: white; font-size: 32px; font-weight: bold; padding: 20px; text-align: center; letter-spacing: 8px; border-radius: 8px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Your MFA Verification Code</h1>
        </div>
        <div class="content">
          <p>Here is your Multi-Factor Authentication verification code:</p>

          <div class="code-box">${code}</div>

          <div class="warning">
            <p><strong>Important:</strong> This code will expire in 5 minutes. Do not share this code with anyone.</p>
          </div>

          <p>If you didn't request this code, you can safely ignore this email.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generateSecurityAlertEmailTemplate(event: any): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Security Alert</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #7c3aed; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f3f4f6; padding: 30px; border-radius: 0 0 8px 8px; }
          .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
          .details { background: #e5e7eb; padding: 15px; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .button { display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Security Alert</h1>
        </div>
        <div class="content">
          <div class="alert-box">
            <p><strong>${event.type}</strong></p>
            <p>${event.description}</p>
          </div>

          <h3>Activity Details:</h3>
          <div class="details">
            <p><strong>IP Address:</strong> ${event.ipAddress}</p>
            <p><strong>Location:</strong> ${event.location || 'Unknown'}</p>
            <p><strong>Time:</strong> ${event.timestamp.toLocaleString()}</p>
          </div>

          <p>If this was you, you can safely ignore this alert. If you don't recognize this activity, please:</p>

          <ul>
            <li>Change your password immediately</li>
            <li>Review your account activity</li>
            <li>Contact support if needed</li>
          </ul>

          <div style="text-align: center;">
            <a href="${this.getBaseUrl()}/auth/security" class="button">Review Account Security</a>
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generateAccountLockedEmailTemplate(reason: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Account Locked</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc2626; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fef2f2; padding: 30px; border-radius: 0 0 8px 8px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .button { display: inline-block; background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Your Account Has Been Locked</h1>
        </div>
        <div class="content">
          <p>Your NOIP Platform account has been locked for security reasons.</p>

          <h3>Reason:</h3>
          <p><em>${reason}</em></p>

          <p>To restore access to your account, please contact our support team.</p>

          <div style="text-align: center;">
            <a href="${this.getBaseUrl()}/support" class="button">Contact Support</a>
          </div>

          <p>We apologize for any inconvenience this may cause.</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generateWelcomeEmailTemplate(username: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to NOIP Platform</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border-radius: 0 0 8px 8px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .feature-list { background: #e0f2fe; padding: 20px; border-radius: 6px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Welcome to NOIP Platform!</h1>
        </div>
        <div class="content">
          <p>Hi ${username},</p>

          <p>Welcome to NOIP Platform! Your account has been created successfully and you're now ready to explore our powerful network operations intelligence features.</p>

          <div class="feature-list">
            <h3>What's Next?</h3>
            <ul>
              <li>Complete your profile setup</li>
              <li>Configure your monitoring preferences</li>
              <li>Explore the dashboard and analytics</li>
              <li>Set up additional security features</li>
            </ul>
          </div>

          <div style="text-align: center;">
            <a href="${this.getBaseUrl()}/dashboard" class="button">Go to Dashboard</a>
          </div>

          <p>If you have any questions or need help getting started, our support team is here to help!</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} NOIP Platform. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  async sendBulkEmails(
    recipients: string[],
    template: string,
    data: any
  ): Promise<void> {
    const promises = recipients.map(email =>
      this.sendEmail({
        to: email,
        subject: data.subject,
        html: template,
        text: data.text,
      })
    );

    try {
      await Promise.all(promises);
      logger.info(`Bulk email sent to ${recipients.length} recipients`);
    } catch (error) {
      logger.error('Failed to send bulk emails', { error });
      throw error;
    }
  }

  async testEmailConfiguration(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      logger.error('Email configuration test failed', { error });
      return false;
    }
  }
}
