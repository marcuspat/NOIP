import mongoose, { Schema, Document, Model } from 'mongoose';
import { Permission } from '../types/auth.types';

// Drop `_id` from the plain-data interface: Mongoose's `Document` provides
// its own typing for it. Keeping both was the source of TS2320 ("Named
// property '_id' of types 'Permission' and 'Document' are not identical").
type PermissionBase = Omit<Permission, '_id'>;

interface PermissionMethods {
  checkCondition(context: Record<string, unknown>): boolean;
  evaluateCondition(
    key: string,
    condition: unknown,
    context: Record<string, unknown>
  ): boolean;
  getContextValue(keyPath: string, context: Record<string, unknown>): unknown;
  evaluateOperator(
    operator: string,
    contextValue: unknown,
    conditionValue: unknown
  ): boolean;
}

export interface PermissionDocument
  extends PermissionBase,
    Document,
    PermissionMethods {}

export interface PermissionModelType extends Model<PermissionDocument> {
  findByResource(resource: string): Promise<PermissionDocument[]>;
  findByAction(action: string): Promise<PermissionDocument[]>;
  findByResourceAndAction(
    resource: string,
    action: string
  ): Promise<PermissionDocument | null>;
  createSystemPermission(
    name: string,
    resource: string,
    action: string,
    description: string,
    conditions?: Record<string, unknown>
  ): Promise<PermissionDocument>;
  findSystemPermissions(): Promise<PermissionDocument[]>;
  findCustomPermissions(): Promise<PermissionDocument[]>;
}

const PermissionSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Permission name is required'],
      unique: true,
      trim: true,
      maxlength: [100, 'Permission name cannot exceed 100 characters'],
    },
    resource: {
      type: String,
      required: [true, 'Resource is required'],
      trim: true,
      maxlength: [50, 'Resource name cannot exceed 50 characters'],
    },
    action: {
      type: String,
      required: [true, 'Action is required'],
      trim: true,
      enum: ['create', 'read', 'update', 'delete', 'execute', 'admin'],
      maxlength: [20, 'Action cannot exceed 20 characters'],
    },
    conditions: {
      type: Schema.Types.Mixed,
      default: {},
    },
    description: {
      type: String,
      required: [true, 'Permission description is required'],
      maxlength: [500, 'Permission description cannot exceed 500 characters'],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret['__v'];
        return ret;
      },
    },
  }
);

// Indexes for performance
PermissionSchema.index({ name: 1 });
PermissionSchema.index({ resource: 1 });
PermissionSchema.index({ action: 1 });
PermissionSchema.index({ isSystem: 1 });
PermissionSchema.index({ resource: 1, action: 1 });

// Compound index for resource-action combinations
PermissionSchema.index({ resource: 1, action: 1 }, { unique: true });

// Method to check if permission conditions are met
PermissionSchema.methods['checkCondition'] = function (
  this: PermissionDocument,
  context: Record<string, unknown>
): boolean {
  if (!this.conditions || Object.keys(this.conditions).length === 0) {
    return true; // No conditions means permission is granted
  }

  try {
    // Evaluate conditions based on context
    for (const [key, condition] of Object.entries(this.conditions)) {
      if (!this.evaluateCondition(key, condition, context)) {
        return false;
      }
    }
    return true;
  } catch {
    // If condition evaluation fails, deny permission for security
    return false;
  }
};

// Helper method to evaluate individual conditions
PermissionSchema.methods['evaluateCondition'] = function (
  this: PermissionDocument,
  key: string,
  condition: unknown,
  context: Record<string, unknown>
): boolean {
  const contextValue = this.getContextValue(key, context);

  if (typeof condition === 'object' && condition !== null) {
    const c = condition as { operator?: string; value?: unknown };
    // Handle complex conditions
    if (c.operator && c.value !== undefined) {
      return this.evaluateOperator(c.operator, contextValue, c.value);
    }
  }

  // Handle simple equality
  return contextValue === condition;
};

// Helper method to get context value by key path
PermissionSchema.methods['getContextValue'] = function (
  _keyPath: string,
  context: Record<string, unknown>
): unknown {
  const keys = _keyPath.split('.');
  let value: unknown = context;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in (value as object)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return value;
};

// Helper method to evaluate operators
PermissionSchema.methods['evaluateOperator'] = function (
  operator: string,
  contextValue: unknown,
  conditionValue: unknown
): boolean {
  switch (operator) {
    case 'equals':
      return contextValue === conditionValue;
    case 'not_equals':
      return contextValue !== conditionValue;
    case 'in':
      return (
        Array.isArray(conditionValue) && conditionValue.includes(contextValue)
      );
    case 'not_in':
      return (
        Array.isArray(conditionValue) && !conditionValue.includes(contextValue)
      );
    case 'contains':
      return (
        typeof contextValue === 'string' &&
        typeof conditionValue === 'string' &&
        contextValue.includes(conditionValue)
      );
    case 'starts_with':
      return (
        typeof contextValue === 'string' &&
        typeof conditionValue === 'string' &&
        contextValue.startsWith(conditionValue)
      );
    case 'ends_with':
      return (
        typeof contextValue === 'string' &&
        typeof conditionValue === 'string' &&
        contextValue.endsWith(conditionValue)
      );
    case 'greater_than':
      return Number(contextValue) > Number(conditionValue);
    case 'less_than':
      return Number(contextValue) < Number(conditionValue);
    case 'greater_than_or_equal':
      return Number(contextValue) >= Number(conditionValue);
    case 'less_than_or_equal':
      return Number(contextValue) <= Number(conditionValue);
    case 'regex': {
      const regex = new RegExp(String(conditionValue));
      return regex.test(String(contextValue));
    }
    default:
      return false;
  }
};

// Static method to find permissions by resource
PermissionSchema.statics['findByResource'] = function (resource: string) {
  return this.find({ resource });
};

// Static method to find permissions by action
PermissionSchema.statics['findByAction'] = function (action: string) {
  return this.find({ action });
};

// Static method to find permissions by resource and action
PermissionSchema.statics['findByResourceAndAction'] = function (
  resource: string,
  action: string
) {
  return this.findOne({ resource, action });
};

// Static method to create system permission
PermissionSchema.statics['createSystemPermission'] = function (
  name: string,
  resource: string,
  action: string,
  description: string,
  conditions?: Record<string, unknown>
) {
  return this.create({
    name,
    resource,
    action,
    description,
    conditions: conditions || {},
    isSystem: true,
  });
};

// Static method to find all system permissions
PermissionSchema.statics['findSystemPermissions'] = function () {
  return this.find({ isSystem: true });
};

// Static method to find all custom permissions
PermissionSchema.statics['findCustomPermissions'] = function () {
  return this.find({ isSystem: false });
};

// Pre-save middleware to validate permission name format
PermissionSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    // Permission name should follow pattern: resource:action:description
    const namePattern = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;
    if (!namePattern.test((this as unknown as { name: string }).name)) {
      const error = new Error(
        'Permission name must follow pattern: resource:action:description'
      );
      return next(error);
    }
  }
  next();
});

export const PermissionModel = mongoose.model<
  PermissionDocument,
  PermissionModelType
>('Permission', PermissionSchema as unknown as Schema<PermissionDocument>);
