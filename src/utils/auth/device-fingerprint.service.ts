import crypto from 'crypto';
import { DeviceInfo } from '../../types/auth.types';
import logger from '../logger';

export class DeviceFingerprintService {
  private readonly fingerprintVersion = '1.0';

  generateFingerprint(requestData?: any): string {
    try {
      const components = [
        this.fingerprintVersion,
        requestData?.userAgent || 'unknown',
        requestData?.acceptLanguage || 'unknown',
        requestData?.platform || 'unknown',
        this.getScreenFingerprint(requestData),
        this.getTimezoneFingerprint(requestData),
        this.getCanvasFingerprint(), // In browser environment
        this.getWebGLFingerprint(), // In browser environment
        this.getAudioContextFingerprint(), // In browser environment
      ];

      const fingerprintString = components.join('|');
      const hash = crypto
        .createHash('sha256')
        .update(fingerprintString)
        .digest('hex');

      logger.debug('Device fingerprint generated', {
        fingerprint: hash.substring(0, 8) + '...',
      });
      return hash;
    } catch (error) {
      logger.error('Failed to generate device fingerprint', { error });
      // Fallback to simple random fingerprint
      return crypto.randomBytes(16).toString('hex');
    }
  }

  extractDeviceInfo(requestData?: any): DeviceInfo {
    try {
      const userAgent = this.parseUserAgent(
        requestData?.userAgent || 'Unknown'
      );

      return {
        platform: userAgent.platform || 'Unknown',
        browser: userAgent.name || 'Unknown',
        version: userAgent.version || 'Unknown',
        mobile: userAgent.mobile || false,
        trusted: false, // Will be updated based on user preferences
        lastSeen: new Date(),
        fingerprint:
          requestData?.deviceFingerprint ||
          this.generateFingerprint(requestData),
      };
    } catch (error) {
      logger.error('Failed to extract device info', { error });
      return {
        platform: 'Unknown',
        browser: 'Unknown',
        version: 'Unknown',
        mobile: false,
        trusted: false,
        lastSeen: new Date(),
        fingerprint:
          requestData?.deviceFingerprint ||
          this.generateFingerprint(requestData),
      };
    }
  }

  verifyDeviceFingerprint(
    storedFingerprint: string,
    currentFingerprint: string
  ): {
    isValid: boolean;
    confidence: number;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let confidence = 0;

    if (storedFingerprint === currentFingerprint) {
      confidence = 100;
      return { isValid: true, confidence, reasons: ['Exact match'] };
    }

    // If fingerprints don't match exactly, calculate similarity
    const similarity = this.calculateFingerprintSimilarity(
      storedFingerprint,
      currentFingerprint
    );
    confidence = Math.round(similarity * 100);

    if (confidence >= 80) {
      reasons.push('High similarity - likely same device');
      return { isValid: true, confidence, reasons };
    } else if (confidence >= 60) {
      reasons.push('Medium similarity - possible same device with updates');
      return { isValid: true, confidence, reasons };
    } else {
      reasons.push('Low similarity - likely different device');
      return { isValid: false, confidence, reasons };
    }
  }

  async trackDeviceActivity(
    userId: string,
    fingerprint: string,
    deviceInfo: DeviceInfo,
    ipAddress: string,
    userAgent: string
  ): Promise<{
    isKnownDevice: boolean;
    isNewLocation: boolean;
    riskScore: number;
  }> {
    try {
      // In a real implementation, this would check against stored device data
      // For now, we'll return mock data

      const isKnownDevice = Math.random() > 0.3; // 70% chance it's a known device
      const isNewLocation = Math.random() > 0.8; // 20% chance it's a new location

      // Calculate risk score based on various factors
      let riskScore = 0;

      if (!isKnownDevice) {
        riskScore += 30;
      }

      if (isNewLocation) {
        riskScore += 25;
      }

      // Add risk for suspicious user agents
      if (this.isSuspiciousUserAgent(userAgent)) {
        riskScore += 20;
      }

      // Add risk for anonymous IP ranges
      if (this.isAnonymousIP(ipAddress)) {
        riskScore += 25;
      }

      logger.info('Device activity tracked', {
        userId,
        fingerprint: fingerprint.substring(0, 8) + '...',
        isKnownDevice,
        isNewLocation,
        riskScore,
      });

      return {
        isKnownDevice,
        isNewLocation,
        riskScore: Math.min(100, riskScore),
      };
    } catch (error) {
      logger.error('Failed to track device activity', { error, userId });
      return {
        isKnownDevice: false,
        isNewLocation: true,
        riskScore: 50,
      };
    }
  }

  isDeviceTrusted(fingerprint: string, userId: string): boolean {
    // In a real implementation, this would check against trusted devices in the database
    return false; // Mock implementation
  }

  async trustDevice(
    userId: string,
    fingerprint: string,
    duration: number = 30
  ): Promise<void> {
    try {
      // In a real implementation, this would add the device to trusted devices
      // Duration is in days
      logger.info('Device marked as trusted', {
        userId,
        fingerprint: fingerprint.substring(0, 8) + '...',
        duration,
      });
    } catch (error) {
      logger.error('Failed to trust device', { error, userId });
      throw new Error('Failed to trust device');
    }
  }

  async revokeTrust(userId: string, fingerprint: string): Promise<void> {
    try {
      // In a real implementation, this would remove the device from trusted devices
      logger.info('Device trust revoked', {
        userId,
        fingerprint: fingerprint.substring(0, 8) + '...',
      });
    } catch (error) {
      logger.error('Failed to revoke device trust', { error, userId });
      throw new Error('Failed to revoke device trust');
    }
  }

  getDeviceFingerprintHistory(userId: string): Promise<
    Array<{
      fingerprint: string;
      deviceInfo: DeviceInfo;
      lastSeen: Date;
      isTrusted: boolean;
      riskScore: number;
    }>
  > {
    // In a real implementation, this would return the device history from the database
    return Promise.resolve([]);
  }

  private getScreenFingerprint(requestData?: any): string {
    if (!requestData) return 'unknown';

    const width = requestData.screenWidth || 'unknown';
    const height = requestData.screenHeight || 'unknown';
    const colorDepth = requestData.colorDepth || 'unknown';
    const pixelRatio = requestData.pixelRatio || 'unknown';

    return `${width}x${height}x${colorDepth}x${pixelRatio}`;
  }

  private getTimezoneFingerprint(requestData?: any): string {
    if (!requestData) return 'unknown';

    return (
      requestData.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'unknown'
    );
  }

  private getCanvasFingerprint(): string {
    // In a browser environment, this would generate a canvas fingerprint
    // For server-side, we'll return a placeholder
    return 'canvas-na';
  }

  private getWebGLFingerprint(): string {
    // In a browser environment, this would generate a WebGL fingerprint
    // For server-side, we'll return a placeholder
    return 'webgl-na';
  }

  private getAudioContextFingerprint(): string {
    // In a browser environment, this would generate an audio context fingerprint
    // For server-side, we'll return a placeholder
    return 'audio-na';
  }

  private parseUserAgent(userAgent: string): any {
    // Simple user agent parsing - in production, you might use a library like ua-parser-js
    const ua = userAgent.toLowerCase();

    const browsers = ['chrome', 'firefox', 'safari', 'edge', 'opera', 'msie'];
    const platforms = ['windows', 'mac', 'linux', 'android', 'ios'];

    let name = 'Unknown';
    let version = 'Unknown';
    let platform = 'Unknown';

    // Detect browser
    for (const browser of browsers) {
      if (ua.includes(browser)) {
        name = browser.charAt(0).toUpperCase() + browser.slice(1);
        const match = ua.match(new RegExp(browser + '[/ ]([\\d.]+)'));
        if (match) {
          version = match[1];
        }
        break;
      }
    }

    // Detect platform
    for (const os of platforms) {
      if (ua.includes(os)) {
        platform = os.charAt(0).toUpperCase() + os.slice(1);
        break;
      }
    }

    // Check for mobile
    const mobile =
      ua.includes('mobile') || ua.includes('android') || ua.includes('ios');

    return { name, version, platform, mobile };
  }

  private calculateFingerprintSimilarity(fp1: string, fp2: string): number {
    if (fp1 === fp2) return 1.0;

    // Simple similarity calculation based on character overlap
    const set1 = new Set(fp1);
    const set2 = new Set(fp2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  private isSuspiciousUserAgent(userAgent: string): boolean {
    const suspiciousPatterns = [
      /bot/i,
      /crawler/i,
      /spider/i,
      /scraper/i,
      /curl/i,
      /wget/i,
      /python/i,
      /java/i,
      /headless/i,
    ];

    return suspiciousPatterns.some(pattern => pattern.test(userAgent));
  }

  private isAnonymousIP(ipAddress: string): boolean {
    // Check for common anonymous/proxy IP ranges
    const anonymousRanges = [
      /^10\./, // Private network
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private network
      /^192\.168\./, // Private network
      /^127\./, // Loopback
      /^169\.254\./, // Link-local
      /^::1$/, // IPv6 loopback
      /^fc00:/, // IPv6 private
      /^fe80:/, // IPv6 link-local
    ];

    return anonymousRanges.some(range => range.test(ipAddress));
  }

  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  validateSessionTokenFormat(token: string): boolean {
    return /^[a-f0-9]{64}$/.test(token);
  }
}
