import mongoose, { Schema, Document, Model } from 'mongoose';
import { Role, Permission } from '../types/auth.types';

// Drop `_id` to let Mongoose's `Document` typing be the single source of
// truth — eliminates the TS2320 conflict between our domain interface and
// the `Document` base.
type RoleBase = Omit<Role, '_id'>;

interface RoleMethods {
  addPermission(permission: Permission | string): Promise<void>;
  removePermission(permission: Permission | string): Promise<void>;
  hasPermission(permissionName: string): boolean;
  getInheritedPermissions(): Promise<Permission[]>;
  checkCircularDependency(
    roleId: string,
    parentIds: string[]
  ): Promise<boolean>;
}

export interface RoleDocument extends RoleBase, Document, RoleMethods {}

export interface RoleModelType extends Model<RoleDocument> {
  findSystemRoles(): Promise<RoleDocument[]>;
  findCustomRoles(): Promise<RoleDocument[]>;
  createSystemRole(
    name: string,
    description: string,
    permissions?: string[]
  ): Promise<RoleDocument>;
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
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret['__v'];
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
RoleSchema.methods['addPermission'] = async function (
  this: RoleDocument,
  permission: Permission | string
): Promise<void> {
  const permissionId =
    typeof permission === 'string' ? permission : permission._id;

  const permissions = this.permissions as unknown as string[];
  if (!permissions.includes(permissionId)) {
    permissions.push(permissionId);
    await this.save();
  }
};

// Method to remove permission from role
RoleSchema.methods['removePermission'] = async function (
  this: RoleDocument,
  permission: Permission | string
): Promise<void> {
  const permissionId =
    typeof permission === 'string' ? permission : permission._id;

  this.permissions = (this.permissions as unknown as string[]).filter(
    (id: string) => id.toString() !== permissionId.toString()
  ) as unknown as RoleDocument['permissions'];
  await this.save();
};

// Method to check if role has specific permission
RoleSchema.methods['hasPermission'] = function (
  this: RoleDocument,
  permissionName: string
): boolean {
  return (this.permissions as unknown as Array<{ name: string }>).some(
    permission => permission.name === permissionName
  );
};

// Method to get inherited permissions from parent roles
RoleSchema.methods['getInheritedPermissions'] = async function (
  this: RoleDocument
): Promise<Permission[]> {
  const inheritedPermissions: Permission[] = [];

  if (this.parentRoles && this.parentRoles.length > 0) {
    for (const parentRoleId of this.parentRoles) {
      const parentRole = await mongoose
        .model('Role')
        .findById(parentRoleId)
        .populate('permissions');
      if (parentRole) {
        inheritedPermissions.push(
          ...(parentRole as unknown as { permissions: Permission[] })
            .permissions
        );
        // Recursively get permissions from parent's parents
        const parentInherited = await (
          parentRole as unknown as RoleDocument
        ).getInheritedPermissions();
        inheritedPermissions.push(...parentInherited);
      }
    }
  }

  return inheritedPermissions;
};

// Static method to find system roles
RoleSchema.statics['findSystemRoles'] = function () {
  return this.find({ isSystem: true });
};

// Static method to find custom roles
RoleSchema.statics['findCustomRoles'] = function () {
  return this.find({ isSystem: false });
};

// Static method to create system role
RoleSchema.statics['createSystemRole'] = function (
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
  const doc = this as unknown as RoleDocument;
  // Check for circular dependencies in parent roles
  if (
    doc.isModified('parentRoles') &&
    doc.parentRoles &&
    doc.parentRoles.length > 0
  ) {
    const hasCircularDependency = await doc.checkCircularDependency(
      String(doc._id),
      (doc.parentRoles as unknown as string[]).map(p => String(p))
    );
    if (hasCircularDependency) {
      const error = new Error('Circular dependency detected in role hierarchy');
      return next(error);
    }
  }
  next();
});

// Helper method to check for circular dependencies
RoleSchema.methods['checkCircularDependency'] = async function (
  roleId: string,
  parentIds: string[]
): Promise<boolean> {
  const visited = new Set<string>();
  const stack: string[] = [...parentIds];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined) {
      break;
    }

    if (currentId === roleId.toString()) {
      return true; // Circular dependency found
    }

    if (visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);

    const currentRole = await mongoose.model('Role').findById(currentId);
    const parentRoles = (
      currentRole as unknown as { parentRoles?: unknown[] } | null
    )?.parentRoles;
    if (currentRole && parentRoles) {
      stack.push(...parentRoles.map(id => String(id)));
    }
  }

  return false;
};

export const RoleModel = mongoose.model<RoleDocument, RoleModelType>(
  'Role',
  RoleSchema as unknown as Schema<RoleDocument>
);
