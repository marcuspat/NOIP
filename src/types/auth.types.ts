export interface User {
  _id: string;
  username: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  permissions: Permission[];
  status: UserStatus;
  mfaEnabled: boolean;
  mfaSecret?: string;
  mfaBackupCodes?: string[];
  ssoProviders?: SSOProvider[];
  lastLogin?: Date;
  loginAttempts: number;
  lockedUntil?: Date;
  passwordChangedAt: Date;
  emailVerified: boolean;
  emailVerificationToken?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface Role {
  _id: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  parentRoles?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Permission {
  _id: string;
  name: string;
  resource: string;
  action: string;
  conditions?: Record<string, any>;
  description: string;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSession {
  _id: string;
  userId: string;
  sessionId: string;
  deviceFingerprint: string;
  deviceInfo: DeviceInfo;
  ipAddress: string;
  userAgent: string;
  location?: GeoLocation;
  isActive: boolean;
  createdAt: Date;
  expiresAt: Date;
  lastActivity: Date;
  mfaVerified: boolean;
}

export interface DeviceInfo {
  platform: string;
  browser: string;
  version: string;
  mobile: boolean;
  trusted: boolean;
  lastSeen: Date;
}

export interface GeoLocation {
  country: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface MFACredentials {
  userId: string;
  secret: string;
  backupCodes: string[];
  enabled: boolean;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SSOProvider {
  _id: string;
  name: string;
  type: SSOType;
  config: SSOConfig;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SSOConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string[];
  issuerUrl?: string;
  entryPoint?: string;
  cert?: string;
  privateKey?: string;
  metadata?: Record<string, any>;
}

export enum SSOType {
  SAML = 'saml',
  OIDC = 'oidc',
  LDAP = 'ldap',
  OAUTH2 = 'oauth2',
}

export interface SSOUserMapping {
  userId: string;
  providerId: string;
  providerUserId: string;
  providerAttributes: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  LOCKED = 'locked',
  PENDING_VERIFICATION = 'pending_verification',
}

export interface JWTTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface JWTPayload {
  sub: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  type: 'access' | 'refresh';
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn: number;
  tokenType: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  mfaCode?: string;
  rememberMe?: boolean;
  deviceFingerprint?: string;
}

export interface LoginResponse {
  user: UserProfile;
  tokens: AuthTokens;
  requiresMFA: boolean;
  mfaMethods?: MFAMethod[];
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  agreeToTerms: boolean;
}

export interface MFAMethod {
  type: 'totp' | 'sms' | 'email' | 'backup';
  name: string;
  enabled: boolean;
  verified: boolean;
}

export interface MFASetupRequest {
  method: MFAMethod['type'];
  phoneNumber?: string;
  emailAddress?: string;
}

export interface MFASetupResponse {
  secret?: string;
  qrCode?: string;
  backupCodes?: string[];
  verificationRequired: boolean;
}

export interface MFAVerificationRequest {
  code: string;
  method: MFAMethod['type'];
  backupCode?: boolean;
}

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordResetConfirmRequest {
  token: string;
  newPassword: string;
  confirmPassword: string;
}

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  permissions: Permission[];
  status: UserStatus;
  mfaEnabled: boolean;
  lastLogin?: Date;
  emailVerified: boolean;
  createdAt: Date;
}

export interface SecurityEvent {
  _id: string;
  userId?: string;
  sessionId?: string;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  description: string;
  ipAddress: string;
  userAgent: string;
  details?: Record<string, any>;
  resolved: boolean;
  createdAt: Date;
}

export enum SecurityEventType {
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILURE = 'login_failure',
  LOGOUT = 'logout',
  PASSWORD_CHANGE = 'password_change',
  PASSWORD_RESET = 'password_reset',
  MFA_ENABLED = 'mfa_enabled',
  MFA_DISABLED = 'mfa_disabled',
  MFA_VERIFICATION_SUCCESS = 'mfa_verification_success',
  MFA_VERIFICATION_FAILURE = 'mfa_verification_failure',
  ACCOUNT_LOCKED = 'account_locked',
  ACCOUNT_UNLOCKED = 'account_unlocked',
  SUSPICIOUS_LOGIN = 'suspicious_login',
  TOKEN_REVOKED = 'token_revoked',
  PERMISSION_ESCALATION = 'permission_escalation',
  DATA_ACCESS = 'data_access',
  CONFIGURATION_CHANGE = 'configuration_change',
}

export enum SecurityEventSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface SecurityPolicy {
  _id: string;
  name: string;
  type: SecurityPolicyType;
  config: SecurityPolicyConfig;
  enabled: boolean;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export enum SecurityPolicyType {
  PASSWORD_POLICY = 'password_policy',
  ACCOUNT_LOCKOUT = 'account_lockout',
  SESSION_POLICY = 'session_policy',
  MFA_POLICY = 'mfa_policy',
  ACCESS_POLICY = 'access_policy',
}

export interface SecurityPolicyConfig {
  passwordPolicy?: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
    preventReuse: number;
    maxAge: number;
  };
  accountLockout?: {
    maxAttempts: number;
    lockoutDuration: number;
    resetAfter: number;
  };
  sessionPolicy?: {
    maxDuration: number;
    idleTimeout: number;
    maxConcurrentSessions: number;
    requireReauth: boolean;
  };
  mfaPolicy?: {
    required: boolean;
    exemptRoles: string[];
    gracePeriod: number;
    trustedDevices: boolean;
  };
  accessPolicy?: {
    allowedIPRanges: string[];
    blockedIPRanges: string[];
    geoRestrictions: string[];
    timeRestrictions: TimeRestriction[];
  };
}

export interface TimeRestriction {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  timezone: string;
}

export interface ApiKey {
  _id: string;
  userId: string;
  name: string;
  keyHash: string;
  permissions: Permission[];
  expiresAt?: Date;
  lastUsed?: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface ServiceAccount {
  _id: string;
  name: string;
  description: string;
  roles: Role[];
  permissions: Permission[];
  apiKeyId: string;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  _id: string;
  userId?: string;
  serviceAccountId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details: Record<string, any>;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
  sessionId?: string;
}

export interface AuthenticationMetrics {
  totalUsers: number;
  activeUsers: number;
  activeSessions: number;
  loginAttempts24h: number;
  successfulLogins24h: number;
  failedLogins24h: number;
  mfaAdoptionRate: number;
  securityEvents24h: number;
  accountsLocked: number;
  passwordResets24h: number;
}

export interface AuthenticationStats {
  dailyLogins: Array<{ date: string; count: number }>;
  failedLoginAttempts: Array<{ date: string; count: number }>;
  mfaUsage: Array<{ method: string; count: number }>;
  userStatusDistribution: Array<{ status: UserStatus; count: number }>;
  securityEventsBySeverity: Array<{
    severity: SecurityEventSeverity;
    count: number;
  }>;
  topIPAddresses: Array<{ ip: string; count: number }>;
}
