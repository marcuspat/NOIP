import mongoose, { Schema, Document } from 'mongoose';
import { Role, Permission } from '../types/auth.types';

export interface RoleDocument extends Role, Document {
  addPermission(permission: Permission | string): Promise<void>;
  removePermission(permission: Permission | string): Promise<void>;
  hasPermission(permissionName: string): boolean;
  getInheritedPermissions(): Promise<Permission[]>;
}

const RoleSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Role name is required'],
      unique: true,
      trim: true,
      maxlength: [50, 'Role name cannot exceed 50 characters'],
      match: [
        /^[a-zA-Z0-9_-]+$/,
        'Role name can only contain letters, numbers, underscores, and hyphens',
      ],
    },
    description: {
      type: String,
      required: [true, 'Role description is required'],
      maxlength: [500, 'Role description cannot exceed 500 characters'],
    },
    permissions: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Permission',
      },
    ],
    isSystem: {
      type: Boolean,
      default: false,
    },
    parentRoles: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Role',
      },
    ],
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
RoleSchema.index({ name: 1 });
RoleSchema.index({ isSystem: 1 });
RoleSchema.index({ parentRoles: 1 });

// Method to add permission to role
RoleSchema.methods.addPermission = async function (
  permission: Permission | string
): Promise<void> {
  const permissionId =
    typeof permission === 'string' ? permission : permission._id;

  if (!this.permissions.includes(permissionId)) {
    this.permissions.push(permissionId);
    await this.save();
  }
};

// Method to remove permission from role
RoleSchema.methods.removePermission = async function (
  permission: Permission | string
): Promise<void> {
  const permissionId =
    typeof permission === 'string' ? permission : permission._id;

  this.permissions = this.permissions.filter(
    (id: string) => id.toString() !== permissionId.toString()
  );
  await this.save();
};

// Method to check if role has specific permission
RoleSchema.methods.hasPermission = function (permissionName: string): boolean {
  return this.permissions.some(
    (permission: any) => permission.name === permissionName
  );
};

// Method to get inherited permissions from parent roles
RoleSchema.methods.getInheritedPermissions = async function (): Promise<
  Permission[]
> {
  const inheritedPermissions: Permission[] = [];

  if (this.parentRoles && this.parentRoles.length > 0) {
    for (const parentRoleId of this.parentRoles) {
      const parentRole = await mongoose
        .model('Role')
        .findById(parentRoleId)
        .populate('permissions');
      if (parentRole) {
        inheritedPermissions.push(...parentRole.permissions);
        // Recursively get permissions from parent's parents
        const parentInherited = await (
          parentRole as RoleDocument
        ).getInheritedPermissions();
        inheritedPermissions.push(...parentInherited);
      }
    }
  }

  return inheritedPermissions;
};

// Static method to find system roles
RoleSchema.statics.findSystemRoles = function () {
  return this.find({ isSystem: true });
};

// Static method to find custom roles
RoleSchema.statics.findCustomRoles = function () {
  return this.find({ isSystem: false });
};

// Static method to create system role
RoleSchema.statics.createSystemRole = function (
  name: string,
  description: string,
  permissions: string[] = []
) {
  return this.create({
    name,
    description,
    permissions,
    isSystem: true,
  });
};

// Pre-save middleware to validate role hierarchy
RoleSchema.pre('save', async function (next) {
  // Check for circular dependencies in parent roles
  if (
    this.isModified('parentRoles') &&
    this.parentRoles &&
    this.parentRoles.length > 0
  ) {
    const hasCircularDependency = await this.checkCircularDependency(
      this._id,
      this.parentRoles
    );
    if (hasCircularDependency) {
      const error = new Error('Circular dependency detected in role hierarchy');
      return next(error);
    }
  }
  next();
});

// Helper method to check for circular dependencies
RoleSchema.methods.checkCircularDependency = async function (
  roleId: string,
  parentIds: string[]
): Promise<boolean> {
  const visited = new Set();
  const stack = [...parentIds];

  while (stack.length > 0) {
    const currentId = stack.pop()!;

    if (currentId === roleId.toString()) {
      return true; // Circular dependency found
    }

    if (visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);

    const currentRole = await mongoose.model('Role').findById(currentId);
    if (currentRole && currentRole.parentRoles) {
      stack.push(...currentRole.parentRoles.map((id: string) => id.toString()));
    }
  }

  return false;
};

export const RoleModel = mongoose.model<RoleDocument>('Role', RoleSchema);
