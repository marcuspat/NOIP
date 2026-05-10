// SecurityPolicy aggregate.
//
// A policy is a versioned definition of a security check. Each update
// bumps `version` and appends the prior version to a separate
// `securityPolicyVersions` collection (DDD-07 invariant). Scans always
// reference the version current at scan start so the result is
// reproducible.

import { newId, type Instant, type PolicyId } from '../../../shared/kernel';
import type { DomainEvent, Clock } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  asPolicyVersion,
  type PolicyConfig,
  type PolicyType,
  type PolicyVersion,
} from './value-objects';

const EVENT_CONTEXT = 'security';
const AGGREGATE_TYPE = 'security_policy';

export interface SecurityPolicyPersistence {
  id: string;
  name: string;
  type: PolicyType;
  config: PolicyConfig;
  enabled: boolean;
  priority: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityPolicyVersionPersistence {
  policyId: string;
  version: number;
  name: string;
  type: PolicyType;
  config: PolicyConfig;
  enabled: boolean;
  priority: number;
  archivedAt: string;
}

export interface SecurityPolicyCreateSpec {
  name: string;
  type: PolicyType;
  config: PolicyConfig;
  priority?: number;
  enabled?: boolean;
  /** Optional explicit id — used by seed loaders. */
  id?: PolicyId;
}

export class SecurityPolicy {
  private _id: PolicyId;
  private _name: string;
  private _type: PolicyType;
  private _config: PolicyConfig;
  private _enabled: boolean;
  private _priority: number;
  private _version: PolicyVersion;
  private _createdAt: Instant;
  private _updatedAt: Instant;
  /**
   * Older versions superseded by this aggregate's current state. The
   * application service drains this list and writes each entry into
   * the `securityPolicyVersions` collection alongside the policy save.
   */
  private readonly _archivedVersions: SecurityPolicyVersionPersistence[] = [];
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: PolicyId;
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    enabled: boolean;
    priority: number;
    version: PolicyVersion;
    createdAt: Instant;
    updatedAt: Instant;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._type = args.type;
    this._config = args.config;
    this._enabled = args.enabled;
    this._priority = args.priority;
    this._version = args.version;
    this._createdAt = args.createdAt;
    this._updatedAt = args.updatedAt;
  }

  static create(spec: SecurityPolicyCreateSpec, clock: Clock): SecurityPolicy {
    if (!spec.name || spec.name.trim().length === 0) {
      throw new ValidationError('policy name is required');
    }
    if (!spec.type) {
      throw new ValidationError('policy type is required');
    }
    const id = spec.id ?? newId<PolicyId>();
    const now = clock.nowInstant();
    const policy = new SecurityPolicy({
      id,
      name: spec.name.trim(),
      type: spec.type,
      config: spec.config,
      enabled: spec.enabled ?? true,
      priority: spec.priority ?? 100,
      version: asPolicyVersion(1),
      createdAt: now,
      updatedAt: now,
    });
    policy._pendingEvents.push(
      compose(
        {
          type: 'security.policy.created',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: { policyId: id, type: spec.type, version: 1 },
        },
        clock
      )
    );
    return policy;
  }

  /**
   * Update the policy. Bumps the version and appends the previous
   * snapshot to `_archivedVersions`. The application service flushes
   * those archived entries to the versions collection.
   */
  update(
    changes: {
      name?: string;
      config?: PolicyConfig;
      priority?: number;
      enabled?: boolean;
    },
    clock: Clock
  ): void {
    // Snapshot the prior version before any mutation.
    const archived: SecurityPolicyVersionPersistence = {
      policyId: this._id,
      version: this._version,
      name: this._name,
      type: this._type,
      config: this._config,
      enabled: this._enabled,
      priority: this._priority,
      archivedAt: clock.nowInstant(),
    };

    let mutated = false;
    if (changes.name !== undefined && changes.name.trim() !== this._name) {
      if (changes.name.trim().length === 0) {
        throw new ValidationError('policy name cannot be empty');
      }
      this._name = changes.name.trim();
      mutated = true;
    }
    if (changes.config !== undefined) {
      this._config = changes.config;
      mutated = true;
    }
    if (changes.priority !== undefined && changes.priority !== this._priority) {
      this._priority = changes.priority;
      mutated = true;
    }
    if (changes.enabled !== undefined && changes.enabled !== this._enabled) {
      this._enabled = changes.enabled;
      mutated = true;
    }
    if (!mutated) return;

    this._archivedVersions.push(archived);
    this._version = asPolicyVersion((this._version as number) + 1);
    this._updatedAt = clock.nowInstant();
    this._pendingEvents.push(
      compose(
        {
          type: 'security.policy.updated',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'system' },
          payload: { policyId: this._id, version: this._version as number },
        },
        clock
      )
    );
    // If the update toggled the enabled flag off, also publish disabled.
    if (changes.enabled === false) {
      this._pendingEvents.push(
        compose(
          {
            type: 'security.policy.disabled',
            context: EVENT_CONTEXT,
            aggregateType: AGGREGATE_TYPE,
            aggregateId: this._id,
            actor: { type: 'system' },
            payload: { policyId: this._id },
          },
          clock
        )
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): PolicyId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get type(): PolicyType {
    return this._type;
  }
  get config(): PolicyConfig {
    return this._config;
  }
  get enabled(): boolean {
    return this._enabled;
  }
  get priority(): number {
    return this._priority;
  }
  get version(): PolicyVersion {
    return this._version;
  }
  get createdAt(): Instant {
    return this._createdAt;
  }
  get updatedAt(): Instant {
    return this._updatedAt;
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  drainArchivedVersions(): SecurityPolicyVersionPersistence[] {
    return this._archivedVersions.splice(0, this._archivedVersions.length);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: SecurityPolicyPersistence): SecurityPolicy {
    return new SecurityPolicy({
      id: doc.id as PolicyId,
      name: doc.name,
      type: doc.type,
      config: doc.config,
      enabled: doc.enabled,
      priority: doc.priority,
      version: asPolicyVersion(doc.version),
      createdAt: doc.createdAt as Instant,
      updatedAt: doc.updatedAt as Instant,
    });
  }

  toPersistence(): SecurityPolicyPersistence {
    return {
      id: this._id,
      name: this._name,
      type: this._type,
      config: this._config,
      enabled: this._enabled,
      priority: this._priority,
      version: this._version as number,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
