import mongoose, { Schema, Document } from 'mongoose';
import { UserSession, DeviceInfo, GeoLocation } from '../types/auth.types';

export interface SessionDocument extends Omit<UserSession, '_id'>, Document {
  isExpired(): boolean;
  extendSession(duration?: number): Promise<void>;
  revoke(): Promise<void>;
  updateLastActivity(): Promise<void>;
  addSecurityEvent(event: string, details?: any): Promise<void>;
}

const DeviceInfoSchema = new Schema(
  {
    platform: { type: String, required: true },
    browser: { type: String, required: true },
    version: { type: String, required: true },
    mobile: { type: Boolean, default: false },
    trusted: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    fingerprint: { type: String, required: true },
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

const SecurityEventSchema = new Schema(
  {
    type: { type: String, required: true },
    description: { type: String, required: true },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SessionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    sessionId: {
      type: String,
      required: [true, 'Session ID is required'],
      unique: true,
      index: true,
    },
    deviceFingerprint: {
      type: String,
      required: [true, 'Device fingerprint is required'],
      index: true,
    },
    deviceInfo: {
      type: DeviceInfoSchema,
      required: true,
    },
    ipAddress: {
      type: String,
      required: [true, 'IP address is required'],
      validate: {
        validator: function (v: string) {
          // Basic IP address validation
          const ipv4Regex =
            /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
          const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
          return ipv4Regex.test(v) || ipv6Regex.test(v);
        },
        message: 'Please enter a valid IP address',
      },
    },
    userAgent: {
      type: String,
      required: [true, 'User agent is required'],
    },
    location: {
      type: GeoLocationSchema,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiration time is required'],
      index: true,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
      index: true,
    },
    mfaVerified: {
      type: Boolean,
      default: false,
    },
    loginMethod: {
      type: String,
      enum: ['password', 'sso', 'mfa', 'api_key'],
      default: 'password',
    },
    securityEvents: [SecurityEventSchema],
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes for performance
SessionSchema.index({ userId: 1, isActive: 1 });
SessionSchema.index({ userId: 1, expiresAt: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index
SessionSchema.index({ deviceFingerprint: 1 });
SessionSchema.index({ ipAddress: 1 });
SessionSchema.index({ createdAt: -1 });

// Method to check if session is expired
SessionSchema.methods.isExpired = function (): boolean {
  return this.expiresAt < new Date();
};

// Method to extend session duration
SessionSchema.methods.extendSession = async function (
  duration: number = 30 * 60 * 1000
): Promise<void> {
  // Default: extend by 30 minutes
  this.expiresAt = new Date(Date.now() + duration);
  this.lastActivity = new Date();
  await this.save();
};

// Method to revoke session
SessionSchema.methods.revoke = async function (): Promise<void> {
  this.isActive = false;
  await this.save();
};

// Method to update last activity
SessionSchema.methods.updateLastActivity = async function (): Promise<void> {
  this.lastActivity = new Date();
  await this.save();
};

// Method to add security event
SessionSchema.methods.addSecurityEvent = async function (
  event: string,
  details: any = {}
): Promise<void> {
  this.securityEvents.push({
    type: event,
    description: `Security event: ${event}`,
    ipAddress: this.ipAddress,
    userAgent: this.userAgent,
    details,
    timestamp: new Date(),
  });
  await this.save();
};

// Static method to find active sessions for user
SessionSchema.statics.findActiveByUser = function (userId: string) {
  return this.find({
    userId,
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).sort({ lastActivity: -1 });
};

// Static method to find sessions by device fingerprint
SessionSchema.statics.findByDeviceFingerprint = function (
  deviceFingerprint: string
) {
  return this.find({
    deviceFingerprint,
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).sort({ lastActivity: -1 });
};

// Static method to find sessions by IP address
SessionSchema.statics.findByIpAddress = function (ipAddress: string) {
  return this.find({
    ipAddress,
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).sort({ lastActivity: -1 });
};

// Static method to revoke all sessions for user
SessionSchema.statics.revokeAllByUser = async function (
  userId: string
): Promise<void> {
  await this.updateMany({ userId, isActive: true }, { isActive: false });
};

// Static method to revoke all sessions except current
SessionSchema.statics.revokeAllExcept = async function (
  userId: string,
  currentSessionId: string
): Promise<void> {
  await this.updateMany(
    { userId, isActive: true, sessionId: { $ne: currentSessionId } },
    { isActive: false }
  );
};

// Static method to cleanup expired sessions
SessionSchema.statics.cleanupExpired = async function (): Promise<number> {
  const result = await this.deleteMany({
    $or: [
      { expiresAt: { $lt: new Date() } },
      {
        isActive: false,
        lastActivity: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      }, // Inactive for 7 days
    ],
  });
  return result.deletedCount;
};

// Static method to get session statistics
SessionSchema.statics.getStatistics = async function () {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    total: await this.countDocuments(),
    active: await this.countDocuments({
      isActive: true,
      expiresAt: { $gt: now },
    }),
    today: await this.countDocuments({ createdAt: { $gte: dayAgo } }),
    thisWeek: await this.countDocuments({ createdAt: { $gte: weekAgo } }),
    mfaVerified: await this.countDocuments({
      mfaVerified: true,
      isActive: true,
    }),
    byLoginMethod: await this.aggregate([
      { $match: { isActive: true, expiresAt: { $gt: now } } },
      { $group: { _id: '$loginMethod', count: { $sum: 1 } } },
    ]),
  };
};

// Pre-save middleware to validate session data
SessionSchema.pre('save', function (next) {
  // Ensure expiration time is in the future
  if (this.expiresAt <= new Date()) {
    const error = new Error('Session expiration time must be in the future');
    return next(error);
  }

  // Deactivate expired sessions
  if ((this as unknown as SessionDocument).isExpired()) {
    this.isActive = false;
  }

  next();
});

// Post-find middleware to automatically handle expired sessions
SessionSchema.post(['find', 'findOne'], function (docs) {
  if (Array.isArray(docs)) {
    docs.forEach(doc => {
      if (doc.isExpired()) {
        doc.isActive = false;
      }
    });
  } else if (docs && docs.isExpired()) {
    docs.isActive = false;
  }
});

export const SessionModel = mongoose.model<SessionDocument>(
  'Session',
  SessionSchema
);
