import mongoose, { Schema, Document } from 'mongoose';
import { Permission } from '../types/auth.types';

export interface PermissionDocument extends Permission, Document {
  checkCondition(context: any): boolean;
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
      transform: function (doc, ret) {
        delete ret.__v;
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
PermissionSchema.methods.checkCondition = function (context: any): boolean {
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
  } catch (error) {
    // If condition evaluation fails, deny permission for security
    return false;
  }
};

// Helper method to evaluate individual conditions
PermissionSchema.methods.evaluateCondition = function (
  key: string,
  condition: any,
  context: any
): boolean {
  const contextValue = this.getContextValue(key, context);

  if (typeof condition === 'object' && condition !== null) {
    // Handle complex conditions
    if (condition.operator && condition.value) {
      return this.evaluateOperator(
        condition.operator,
        contextValue,
        condition.value
      );
    }
  }

  // Handle simple equality
  return contextValue === condition;
};

// Helper method to get context value by key path
PermissionSchema.methods.getContextValue = function (
  keyPath: string,
  context: any
): any {
  const keys = keyPath.split('.');
  let value = context;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return undefined;
    }
  }

  return value;
};

// Helper method to evaluate operators
PermissionSchema.methods.evaluateOperator = function (
  operator: string,
  contextValue: any,
  conditionValue: any
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
        contextValue.includes(conditionValue)
      );
    case 'starts_with':
      return (
        typeof contextValue === 'string' &&
        contextValue.startsWith(conditionValue)
      );
    case 'ends_with':
      return (
        typeof contextValue === 'string' &&
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
    case 'regex':
      const regex = new RegExp(conditionValue);
      return regex.test(String(contextValue));
    default:
      return false;
  }
};

// Static method to find permissions by resource
PermissionSchema.statics.findByResource = function (resource: string) {
  return this.find({ resource });
};

// Static method to find permissions by action
PermissionSchema.statics.findByAction = function (action: string) {
  return this.find({ action });
};

// Static method to find permissions by resource and action
PermissionSchema.statics.findByResourceAndAction = function (
  resource: string,
  action: string
) {
  return this.findOne({ resource, action });
};

// Static method to create system permission
PermissionSchema.statics.createSystemPermission = function (
  name: string,
  resource: string,
  action: string,
  description: string,
  conditions?: any
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
PermissionSchema.statics.findSystemPermissions = function () {
  return this.find({ isSystem: true });
};

// Static method to find all custom permissions
PermissionSchema.statics.findCustomPermissions = function () {
  return this.find({ isSystem: false });
};

// Pre-save middleware to validate permission name format
PermissionSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    // Permission name should follow pattern: resource:action:description
    const namePattern = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;
    if (!namePattern.test(this.name)) {
      const error = new Error(
        'Permission name must follow pattern: resource:action:description'
      );
      return next(error);
    }
  }
  next();
});

export const PermissionModel = mongoose.model<PermissionDocument>(
  'Permission',
  PermissionSchema
);
