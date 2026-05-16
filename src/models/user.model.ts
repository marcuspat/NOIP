import mongoose, { Schema, Document, Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserStatus } from '../types/auth.types';

// Drop `_id` to defer to `Document` typing — eliminates the TS2320 clash
// between our domain `User` and Mongoose's `Document` base.
type UserBase = Omit<User, '_id'>;

interface UserMethods {
  comparePassword(candidatePassword: string): Promise<boolean>;
  generatePasswordResetToken(): string;
  generateEmailVerificationToken(): string;
  isLocked(): boolean;
  incrementLoginAttempts(): Promise<void>;
  resetLoginAttempts(): Promise<void>;
}

export interface UserDocument extends UserBase, Document, UserMethods {}

export interface UserModelType extends Model<UserDocument> {
  findActive(): Promise<UserDocument[]>;
  findByRole(roleName: string): Promise<UserDocument[]>;
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
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret['passwordHash'];
        delete ret['mfaSecret'];
        delete ret['mfaBackupCodes'];
        delete ret['emailVerificationToken'];
        delete ret['passwordResetToken'];
        delete ret['passwordResetExpires'];
        delete ret['__v'];
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
UserSchema.methods['comparePassword'] = async function (
  this: UserDocument,
  candidatePassword: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  } catch {
    throw new Error('Password comparison failed');
  }
};

// Generate password reset token
UserSchema.methods['generatePasswordResetToken'] = function (
  this: UserDocument
): string {
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  return resetToken;
};

// Generate email verification token
UserSchema.methods['generateEmailVerificationToken'] = function (
  this: UserDocument
): string {
  const verificationToken = crypto.randomBytes(32).toString('hex');

  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');

  return verificationToken;
};

// Check if user is locked
UserSchema.methods['isLocked'] = function (this: UserDocument): boolean {
  return !!(this.lockedUntil && this.lockedUntil.getTime() > Date.now());
};

// Increment login attempts
UserSchema.methods['incrementLoginAttempts'] = async function (
  this: UserDocument
): Promise<void> {
  // If we have a previous lock that has expired, restart at 1
  if (this.lockedUntil && this.lockedUntil.getTime() < Date.now()) {
    await this.updateOne({
      $unset: { lockedUntil: 1 },
      $set: { loginAttempts: 1 },
    });
    return;
  }

  const updates: {
    $inc: { loginAttempts: number };
    $set?: { lockedUntil: number };
  } = {
    $inc: { loginAttempts: 1 },
  };

  // Lock account after 5 failed attempts for 2 hours
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockedUntil: Date.now() + 2 * 60 * 60 * 1000 }; // 2 hours
  }

  await this.updateOne(updates);
};

// Reset login attempts
UserSchema.methods['resetLoginAttempts'] = async function (
  this: UserDocument
): Promise<void> {
  await this.updateOne({
    $unset: { loginAttempts: 1, lockedUntil: 1 },
  });
};

// Pre-save middleware to hash password
UserSchema.pre('save', async function (next) {
  const doc = this as unknown as UserDocument;
  // Only hash the password if it has been modified (or is new)
  if (!doc.isModified('passwordHash')) return next();

  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    doc.passwordHash = await bcrypt.hash(doc.passwordHash, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

// Pre-save middleware to update passwordChangedAt
UserSchema.pre('save', function (next) {
  const doc = this as unknown as UserDocument;
  if (!doc.isModified('passwordHash') || doc.isNew) return next();

  doc.passwordChangedAt = new Date(Date.now() - 1000); // Subtract 1 second to ensure token is created after password change
  next();
});

// Static method to find active users
UserSchema.statics['findActive'] = function () {
  return this.find({ status: UserStatus.ACTIVE });
};

// Static method to find users by role
UserSchema.statics['findByRole'] = function (roleName: string) {
  return this.find({ roles: { $in: [roleName] } });
};

// Virtual for full name
UserSchema.virtual('fullName').get(function (this: UserDocument) {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for active sessions
UserSchema.virtual('activeSessions').get(function (this: UserDocument) {
  return (
    this.sessions as unknown as Array<{ isActive: boolean; expiresAt: Date }>
  ).filter(session => session.isActive && session.expiresAt > new Date());
});

export const UserModel = mongoose.model<UserDocument, UserModelType>(
  'User',
  UserSchema as unknown as Schema<UserDocument>
);
