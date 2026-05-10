import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';
import { User, UserStatus, Role, Permission } from '../types/auth.types';

export interface UserDocument extends User, Document {
  comparePassword(candidatePassword: string): Promise<boolean>;
  generatePasswordResetToken(): string;
  generateEmailVerificationToken(): string;
  isLocked(): boolean;
  incrementLoginAttempts(): Promise<void>;
  resetLoginAttempts(): Promise<void>;
}

const DeviceInfoSchema = new Schema(
  {
    platform: { type: String, required: true },
    browser: { type: String, required: true },
    version: { type: String, required: true },
    mobile: { type: Boolean, default: false },
    trusted: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
  },
  { _id: false }
);

const GeoLocationSchema = new Schema(
  {
    country: { type: String },
    region: { type: String },
    city: { type: String },
    latitude: { type: Number },
    longitude: { type: Number },
  },
  { _id: false }
);

const SessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    deviceFingerprint: { type: String, required: true },
    deviceInfo: { type: DeviceInfoSchema, required: true },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true },
    location: { type: GeoLocationSchema },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true },
    lastActivity: { type: Date, default: Date.now },
    mfaVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const SSOProviderSchema = new Schema(
  {
    providerId: { type: String, required: true },
    providerType: {
      type: String,
      enum: ['saml', 'oidc', 'ldap', 'oauth2'],
      required: true,
    },
    providerUserId: { type: String, required: true },
    providerAttributes: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    lastSync: { type: Date },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters long'],
      maxlength: [50, 'Username cannot exceed 50 characters'],
      match: [
        /^[a-zA-Z0-9_-]+$/,
        'Username can only contain letters, numbers, underscores, and hyphens',
      ],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please enter a valid email address',
      ],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters long'],
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      maxlength: [50, 'First name cannot exceed 50 characters'],
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      maxlength: [50, 'Last name cannot exceed 50 characters'],
    },
    roles: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Role',
      },
    ],
    permissions: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Permission',
      },
    ],
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.PENDING_VERIFICATION,
    },
    mfaEnabled: {
      type: Boolean,
      default: false,
    },
    mfaSecret: {
      type: String,
      select: false, // Exclude from queries by default
    },
    mfaBackupCodes: [
      {
        type: String,
        select: false, // Exclude from queries by default
      },
    ],
    ssoProviders: [SSOProviderSchema],
    lastLogin: {
      type: Date,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
    },
    passwordChangedAt: {
      type: Date,
      default: Date.now,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      select: false, // Exclude from queries by default
    },
    passwordResetToken: {
      type: String,
      select: false, // Exclude from queries by default
    },
    passwordResetExpires: {
      type: Date,
      select: false, // Exclude from queries by default
    },
    sessions: [SessionSchema],
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.passwordHash;
        delete ret.mfaSecret;
        delete ret.mfaBackupCodes;
        delete ret.emailVerificationToken;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes for performance
UserSchema.index({ username: 1 });
UserSchema.index({ email: 1 });
UserSchema.index({ status: 1 });
UserSchema.index({ 'sessions.sessionId': 1 });
UserSchema.index({ 'sessions.deviceFingerprint': 1 });
UserSchema.index({ emailVerificationToken: 1 });
UserSchema.index({ passwordResetToken: 1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ lastLogin: -1 });

// Password comparison method
UserSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  } catch (error) {
    throw new Error('Password comparison failed');
  }
};

// Generate password reset token
UserSchema.methods.generatePasswordResetToken = function (): string {
  const crypto = require('crypto');
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  return resetToken;
};

// Generate email verification token
UserSchema.methods.generateEmailVerificationToken = function (): string {
  const crypto = require('crypto');
  const verificationToken = crypto.randomBytes(32).toString('hex');

  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');

  return verificationToken;
};

// Check if user is locked
UserSchema.methods.isLocked = function (): boolean {
  return !!(this.lockedUntil && this.lockedUntil > Date.now());
};

// Increment login attempts
UserSchema.methods.incrementLoginAttempts = async function (): Promise<void> {
  // If we have a previous lock that has expired, restart at 1
  if (this.lockedUntil && this.lockedUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockedUntil: 1 },
      $set: { loginAttempts: 1 },
    });
  }

  const updates: any = { $inc: { loginAttempts: 1 } };

  // Lock account after 5 failed attempts for 2 hours
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockedUntil: Date.now() + 2 * 60 * 60 * 1000 }; // 2 hours
  }

  return this.updateOne(updates);
};

// Reset login attempts
UserSchema.methods.resetLoginAttempts = async function (): Promise<void> {
  return this.updateOne({
    $unset: { loginAttempts: 1, lockedUntil: 1 },
  });
};

// Pre-save middleware to hash password
UserSchema.pre('save', async function (next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('passwordHash')) return next();

  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

// Pre-save middleware to update passwordChangedAt
UserSchema.pre('save', function (next) {
  if (!this.isModified('passwordHash') || this.isNew) return next();

  this.passwordChangedAt = new Date(Date.now() - 1000); // Subtract 1 second to ensure token is created after password change
  next();
});

// Static method to find active users
UserSchema.statics.findActive = function () {
  return this.find({ status: UserStatus.ACTIVE });
};

// Static method to find users by role
UserSchema.statics.findByRole = function (roleName: string) {
  return this.find({ roles: { $in: [roleName] } });
};

// Virtual for full name
UserSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for active sessions
UserSchema.virtual('activeSessions').get(function () {
  return this.sessions.filter(
    (session: any) => session.isActive && session.expiresAt > new Date()
  );
});

export const UserModel = mongoose.model<UserDocument>('User', UserSchema);
