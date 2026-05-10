// Cluster aggregate root.
//
// Holds the small, slow-changing connection metadata for a Kubernetes
// cluster NOIP scans. Scans, snapshots, and drift reports reference
// `ClusterId` — they are not children of this aggregate.
//
// Invariants enforced here (DDD-06):
//   - `endpoint` non-empty and roughly URL-shaped.
//   - `credentials` is a reference, never inlined.
//   - A scan may only run when `enabled === true`.

import { newId, type ClusterId, type Instant } from '../../../shared/kernel';
import type { DomainEvent, Clock } from '../../../shared/kernel';
import { compose } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import type { EventId } from '../../../shared/kernel';

export interface ClusterCredentialsRef {
  /** Logical reference (e.g. `vault://kv/cluster/prod-east`). */
  ref: string;
}

export interface ClusterPersistence {
  id: string;
  name: string;
  endpoint: string;
  version: string;
  credentials: ClusterCredentialsRef;
  registeredAt: string;
  lastScanAt: string | null;
  enabled: boolean;
}

export interface ClusterRegisterSpec {
  name: string;
  endpoint: string;
  version?: string;
  credentials: ClusterCredentialsRef;
}

const EVENT_CONTEXT = 'discovery';
const AGGREGATE_TYPE = 'cluster';

export class Cluster {
  // Backing fields are mutable internally; outside callers go through
  // accessors so the aggregate can enforce invariants on every change.
  private _id: ClusterId;
  private _name: string;
  private _endpoint: string;
  private _version: string;
  private _credentials: ClusterCredentialsRef;
  private _registeredAt: Instant;
  private _lastScanAt: Instant | null;
  private _enabled: boolean;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: ClusterId;
    name: string;
    endpoint: string;
    version: string;
    credentials: ClusterCredentialsRef;
    registeredAt: Instant;
    lastScanAt: Instant | null;
    enabled: boolean;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._endpoint = args.endpoint;
    this._version = args.version;
    this._credentials = args.credentials;
    this._registeredAt = args.registeredAt;
    this._lastScanAt = args.lastScanAt;
    this._enabled = args.enabled;
  }

  // ---------------------------------------------------------------------------
  // Factory: register a brand-new cluster. Emits
  // `discovery.cluster.registered`.
  // ---------------------------------------------------------------------------
  static register(spec: ClusterRegisterSpec, clock: Clock): Cluster {
    if (!spec.name || spec.name.trim().length === 0) {
      throw new ValidationError('cluster name is required');
    }
    if (!spec.endpoint || !/^https?:\/\//i.test(spec.endpoint)) {
      throw new ValidationError(
        'cluster endpoint must be a http(s) URL',
        { endpoint: spec.endpoint }
      );
    }
    if (!spec.credentials || !spec.credentials.ref) {
      throw new ValidationError('cluster credentials reference is required');
    }

    const id = newId<ClusterId>();
    const cluster = new Cluster({
      id,
      name: spec.name.trim(),
      endpoint: spec.endpoint,
      version: spec.version ?? '',
      credentials: spec.credentials,
      registeredAt: clock.nowInstant(),
      lastScanAt: null,
      enabled: true,
    });

    cluster._pendingEvents.push(
      compose(
        {
          type: 'discovery.cluster.registered',
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: id,
          actor: { type: 'system' },
          payload: {
            clusterId: id,
            endpoint: cluster._endpoint,
            name: cluster._name,
          },
        },
        clock
      )
    );

    return cluster;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): ClusterId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get endpoint(): string {
    return this._endpoint;
  }
  get version(): string {
    return this._version;
  }
  get credentials(): ClusterCredentialsRef {
    return this._credentials;
  }
  get registeredAt(): Instant {
    return this._registeredAt;
  }
  get lastScanAt(): Instant | null {
    return this._lastScanAt;
  }
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Drains pending events for the application service to publish *after*
   * the repository save commits. Call sites must publish exactly the
   * returned events in order, then discard them.
   */
  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }

  /** Test helper: peek without draining. */
  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  // ---------------------------------------------------------------------------
  // Mutators (each enforces an invariant)
  // ---------------------------------------------------------------------------
  enable(): void {
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
  }

  /**
   * Records that a scan for this cluster just completed. Bumps
   * `lastScanAt` only if the new instant is monotonically later than
   * what we already have — protects against clock-skew-induced rewinds
   * when multiple workers race.
   */
  markScanned(at: Instant): void {
    if (!this._enabled) {
      throw new ValidationError(
        'cannot mark scan on a disabled cluster',
        { clusterId: this._id }
      );
    }
    if (this._lastScanAt === null || at >= this._lastScanAt) {
      this._lastScanAt = at;
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: ClusterPersistence): Cluster {
    return new Cluster({
      id: doc.id as ClusterId,
      name: doc.name,
      endpoint: doc.endpoint,
      version: doc.version,
      credentials: doc.credentials,
      registeredAt: doc.registeredAt as Instant,
      lastScanAt: doc.lastScanAt === null ? null : (doc.lastScanAt as Instant),
      enabled: doc.enabled,
    });
  }

  toPersistence(): ClusterPersistence {
    return {
      id: this._id,
      name: this._name,
      endpoint: this._endpoint,
      version: this._version,
      credentials: this._credentials,
      registeredAt: this._registeredAt,
      lastScanAt: this._lastScanAt,
      enabled: this._enabled,
    };
  }

  /** Test helper: stamp a deterministic event id on outbound events. */
  withDeterministicEventId(id: EventId): void {
    if (this._pendingEvents.length > 0) {
      const last = this._pendingEvents[this._pendingEvents.length - 1];
      if (last) {
        last.id = id;
      }
    }
  }
}
