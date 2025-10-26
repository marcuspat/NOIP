import mongoose, { Schema, Document } from 'mongoose';
import { SecurityEvent, SecurityEventType, SecurityEventSeverity } from '../types/auth.types';

export interface SecurityEventDocument extends SecurityEvent, Document {
  markResolved(): Promise<void>;
  escalateSeverity(severity: SecurityEventSeverity): Promise<void>;
  addContext(context: Record<string, any>): Promise<void>;
}

const SecurityEventSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sessionId: {
    type: Schema.Types.ObjectId,
    ref: 'Session',
    index: true
  },
  type: {
    type: String,
    enum: Object.values(SecurityEventType),
    required: [true, 'Event type is required'],
    index: true
  },
  severity: {
    type: String,
    enum: Object.values(SecurityEventSeverity),
    required: [true, 'Event severity is required'],
    default: SecurityEventSeverity.MEDIUM,
    index: true
  },
  description: {
    type: String,
    required: [true, 'Event description is required'],
    maxlength: [1000, 'Event description cannot exceed 1000 characters']
  },
  ipAddress: {
    type: String,
    required: [true, 'IP address is required'],
    validate: {
      validator: function(v: string) {
        const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
        return ipv4Regex.test(v) || ipv6Regex.test(v);
      },
      message: 'Please enter a valid IP address'
    },
    index: true
  },
  userAgent: {
    type: String,
    required: [true, 'User agent is required']
  },
  details: {
    type: Schema.Types.Mixed,
    default: {}
  },
  resolved: {
    type: Boolean,
    default: false,
    index: true
  },
  resolvedAt: {
    type: Date
  },
  resolvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  resolutionNotes: {
    type: String,
    maxlength: [1000, 'Resolution notes cannot exceed 1000 characters']
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for performance
SecurityEventSchema.index({ createdAt: -1 });
SecurityEventSchema.index({ userId: 1, createdAt: -1 });
SecurityEventSchema.index({ type: 1, createdAt: -1 });
SecurityEventSchema.index({ severity: 1, createdAt: -1 });
SecurityEventSchema.index({ resolved: 1, createdAt: -1 });
SecurityEventSchema.index({ ipAddress: 1, createdAt: -1 });

// Compound indexes
SecurityEventSchema.index({ type: 1, severity: 1, createdAt: -1 });
SecurityEventSchema.index({ userId: 1, resolved: 1, createdAt: -1 });

// Method to mark event as resolved
SecurityEventSchema.methods.markResolved = async function(resolvedBy?: string, notes?: string): Promise<void> {
  this.resolved = true;
  this.resolvedAt = new Date();
  if (resolvedBy) {
    this.resolvedBy = resolvedBy;
  }
  if (notes) {
    this.resolutionNotes = notes;
  }
  await this.save();
};

// Method to escalate event severity
SecurityEventSchema.methods.escalateSeverity = async function(severity: SecurityEventSeverity): Promise<void> {
  this.severity = severity;
  await this.save();
};

// Method to add context information
SecurityEventSchema.methods.addContext = async function(context: Record<string, any>): Promise<void> {
  this.details = { ...this.details, ...context };
  await this.save();
};

// Static method to find critical events
SecurityEventSchema.statics.findCriticalEvents = function() {
  return this.find({
    severity: SecurityEventSeverity.CRITICAL,
    resolved: false
  }).sort({ createdAt: -1 });
};

// Static method to find events by user
SecurityEventSchema.statics.findByUser = function(userId: string, limit: number = 100) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to find events by type
SecurityEventSchema.statics.findByType = function(type: SecurityEventType, limit: number = 100) {
  return this.find({ type })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to find suspicious login patterns
SecurityEventSchema.statics.findSuspiciousLogins = function(hours: number = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  return this.find({
    type: { $in: [SecurityEventType.LOGIN_FAILURE, SecurityEventType.SUSPICIOUS_LOGIN] },
    createdAt: { $gte: since },
    resolved: false
  }).sort({ createdAt: -1 });
};

// Static method to get security statistics
SecurityEventSchema.statics.getStatistics = async function(days: number = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalEvents,
    unresolvedEvents,
    criticalEvents,
    eventsByType,
    eventsBySeverity,
    topIPAddresses,
    recentEvents
  ] = await Promise.all([
    this.countDocuments({ createdAt: { $gte: since } }),
    this.countDocuments({ createdAt: { $gte: since }, resolved: false }),
    this.countDocuments({
      createdAt: { $gte: since },
      severity: SecurityEventSeverity.CRITICAL,
      resolved: false
    }),
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } }
    ]),
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$ipAddress', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]),
    this.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(10)
  ]);

  return {
    totalEvents,
    unresolvedEvents,
    criticalEvents,
    eventsByType,
    eventsBySeverity,
    topIPAddresses,
    recentEvents
  };
};

// Static method to create security event
SecurityEventSchema.statics.createEvent = async function(
  type: SecurityEventType,
  description: string,
  ipAddress: string,
  userAgent: string,
  options: {
    userId?: string;
    sessionId?: string;
    severity?: SecurityEventSeverity;
    details?: Record<string, any>;
  } = {}
) {
  return this.create({
    type,
    description,
    ipAddress,
    userAgent,
    ...options
  });
};

// Static method to cleanup old resolved events
SecurityEventSchema.statics.cleanupOldEvents = async function(days: number = 90): Promise<number> {
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await this.deleteMany({
    resolved: true,
    resolvedAt: { $lt: cutoffDate }
  });

  return result.deletedCount;
};

// Pre-save middleware to validate event data
SecurityEventSchema.pre('save', function(next) {
  // Auto-set resolvedAt if resolved is set to true
  if (this.isModified('resolved') && this.resolved && !this.resolvedAt) {
    this.resolvedAt = new Date();
  }

  // Ensure critical events have detailed descriptions
  if (this.severity === SecurityEventSeverity.CRITICAL && this.description.length < 20) {
    const error = new Error('Critical events must have detailed descriptions (at least 20 characters)');
    return next(error);
  }

  next();
});

// Static method to auto-resolve low-risk events
SecurityEventSchema.statics.autoResolveLowRiskEvents = async function(): Promise<number> {
  const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

  const result = await this.updateMany(
    {
      severity: { $in: [SecurityEventSeverity.LOW] },
      createdAt: { $lt: cutoffDate },
      resolved: false
    },
    {
      resolved: true,
      resolvedAt: new Date(),
      resolutionNotes: 'Auto-resolved: Low risk event older than 7 days'
    }
  );

  return result.modifiedCount;
};

export const SecurityEventModel = mongoose.model<SecurityEventDocument>('SecurityEvent', SecurityEventSchema);