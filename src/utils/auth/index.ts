// Public surface barrel for the auth utilities. AuthService and the
// auth middleware import these collaborators from here.

export { JWTManager } from './jwt.manager';
export type {
  JWTKey,
  RedisLike,
  FamilyState,
  RotatedTokenPair,
  JWTManagerOptions,
  PasswordChangedAtLoader,
} from './jwt.manager';

export { MFAService } from './mfa.service';
export type {
  MFARedisClient,
  MFABackupHasher,
  MFAClock,
  MFALogger,
  MFAServiceDeps,
} from './mfa.service';
export { PasswordService } from './password.service';
export { DeviceFingerprintService } from './device-fingerprint.service';
export { EmailService } from './email.service';
