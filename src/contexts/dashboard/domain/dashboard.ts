// Dashboard aggregate root (DDD-10).
//
// Composes a named set of `Widget`s plus a `SharePolicy`. The aggregate
// is purely a read view: it never mutates other contexts' state. The
// only writes it produces are to its own row + the matching domain
// events on the bus.
//
// Invariants:
//   - `widgets` cannot overlap when `layout === 'grid'`.
//   - All widget positions are non-negative (enforced by Widget).
//   - `refreshIntervalSec >= MIN_REFRESH_INTERVAL_SEC`.
//   - `share.visibility ∈ {private, role-scoped, organisation}`. A
//     role-scoped share carries an explicit non-empty `roles` list.
//   - `share.roles` is only meaningful when `visibility === 'role-scoped'`.
//
// Events emitted:
//   - `dashboard.created` (factory)
//   - `dashboard.updated` (renames, layout/refresh tweaks, widget changes)
//   - `dashboard.deleted` (explicit delete; service calls `markDeleted`)
//   - `dashboard.shared` (when `share` is replaced or visibility changes)

import {
  compose,
  newId,
  type Clock,
  type DashboardId,
  type DomainEvent,
  type Instant,
  type WidgetId,
} from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  Widget,
  rectanglesOverlap,
  type WidgetPersistence,
  type WidgetSpec,
} from './widget';
import {
  MIN_REFRESH_INTERVAL_SEC,
  type ActorRef,
  type DashboardLayout,
  type SharePolicy,
  type ShareVisibility,
} from './value-objects';

const EVENT_CONTEXT = 'dashboard';
const AGGREGATE_TYPE = 'dashboard';

const SUPPORTED_LAYOUTS: ReadonlySet<DashboardLayout> = new Set([
  'grid',
  'flex',
]);

const SUPPORTED_VISIBILITIES: ReadonlySet<ShareVisibility> = new Set([
  'private',
  'role-scoped',
  'organisation',
]);

export interface DashboardPersistence {
  id: string;
  name: string;
  description: string;
  layout: DashboardLayout;
  refreshIntervalSec: number;
  widgets: WidgetPersistence[];
  ownedBy: ActorRef;
  share: SharePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardCreateSpec {
  name: string;
  description?: string;
  layout: DashboardLayout;
  refreshIntervalSec?: number;
  widgets?: WidgetSpec[];
  ownedBy: ActorRef;
  share?: SharePolicy;
}

export interface DashboardUpdateSpec {
  name?: string;
  description?: string;
  layout?: DashboardLayout;
  refreshIntervalSec?: number;
  widgets?: WidgetSpec[];
}

const DEFAULT_SHARE: SharePolicy = { visibility: 'private' };
const DEFAULT_REFRESH_INTERVAL_SEC = 60;

function assertLayout(layout: DashboardLayout): void {
  if (!SUPPORTED_LAYOUTS.has(layout)) {
    throw new ValidationError('unsupported dashboard layout', { layout });
  }
}

function assertRefreshInterval(sec: number): void {
  if (!Number.isFinite(sec) || sec < MIN_REFRESH_INTERVAL_SEC) {
    throw new ValidationError(
      `dashboard refreshIntervalSec must be ≥ ${MIN_REFRESH_INTERVAL_SEC}`,
      { refreshIntervalSec: sec }
    );
  }
}

function assertSharePolicy(share: SharePolicy): void {
  if (!share || !SUPPORTED_VISIBILITIES.has(share.visibility)) {
    throw new ValidationError('unsupported share visibility', {
      visibility: share?.visibility,
    });
  }
  if (share.visibility === 'role-scoped') {
    if (!share.roles || share.roles.length === 0) {
      throw new ValidationError(
        'role-scoped share requires a non-empty roles list'
      );
    }
    for (const r of share.roles) {
      if (typeof r !== 'string' || r.trim().length === 0) {
        throw new ValidationError(
          'role-scoped share roles must be non-empty strings'
        );
      }
    }
  } else if (share.roles && share.roles.length > 0) {
    throw new ValidationError(
      'roles can only be supplied for role-scoped shares',
      { visibility: share.visibility }
    );
  }
}

/**
 * Verifies grid widgets do not overlap. Pure function so the aggregate
 * + tests both call it. Reports the first conflict it finds; that is
 * enough to give the operator something to fix.
 */
export function assertNoOverlap(widgets: ReadonlyArray<Widget>): void {
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i]!;
      const b = widgets[j]!;
      if (rectanglesOverlap(a.position, b.position)) {
        throw new ValidationError('widgets overlap in grid layout', {
          aId: a.id,
          aPosition: a.position,
          bId: b.id,
          bPosition: b.position,
        });
      }
    }
  }
}

export class Dashboard {
  private _id: DashboardId;
  private _name: string;
  private _description: string;
  private _layout: DashboardLayout;
  private _refreshIntervalSec: number;
  private _widgets: Widget[];
  private _ownedBy: ActorRef;
  private _share: SharePolicy;
  private _createdAt: Instant;
  private _updatedAt: Instant;
  private _deleted = false;
  private readonly _pendingEvents: DomainEvent<unknown>[] = [];

  private constructor(args: {
    id: DashboardId;
    name: string;
    description: string;
    layout: DashboardLayout;
    refreshIntervalSec: number;
    widgets: Widget[];
    ownedBy: ActorRef;
    share: SharePolicy;
    createdAt: Instant;
    updatedAt: Instant;
  }) {
    this._id = args.id;
    this._name = args.name;
    this._description = args.description;
    this._layout = args.layout;
    this._refreshIntervalSec = args.refreshIntervalSec;
    this._widgets = args.widgets;
    this._ownedBy = args.ownedBy;
    this._share = args.share;
    this._createdAt = args.createdAt;
    this._updatedAt = args.updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  static create(spec: DashboardCreateSpec, clock: Clock): Dashboard {
    const name = (spec.name ?? '').trim();
    if (name.length === 0) {
      throw new ValidationError('dashboard name is required');
    }
    assertLayout(spec.layout);
    const refresh = spec.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC;
    assertRefreshInterval(refresh);
    const share = spec.share ?? DEFAULT_SHARE;
    assertSharePolicy(share);
    if (!spec.ownedBy || typeof spec.ownedBy.userId !== 'string') {
      throw new ValidationError('dashboard ownedBy.userId is required');
    }

    const widgets = (spec.widgets ?? []).map(w => Widget.create(w));
    if (spec.layout === 'grid') {
      assertNoOverlap(widgets);
    }

    const id = newId<DashboardId>();
    const now = clock.nowInstant();
    const d = new Dashboard({
      id,
      name,
      description: (spec.description ?? '').trim(),
      layout: spec.layout,
      refreshIntervalSec: refresh,
      widgets,
      ownedBy: { ...spec.ownedBy },
      share: { ...share, ...(share.roles ? { roles: [...share.roles] } : {}) },
      createdAt: now,
      updatedAt: now,
    });
    d._emit('dashboard.created', clock, {
      dashboardId: id,
      ownedBy: spec.ownedBy,
    });
    return d;
  }

  static fromPersistence(doc: DashboardPersistence): Dashboard {
    return new Dashboard({
      id: doc.id as DashboardId,
      name: doc.name,
      description: doc.description,
      layout: doc.layout,
      refreshIntervalSec: doc.refreshIntervalSec,
      widgets: doc.widgets.map(w => Widget.fromPersistence(w)),
      ownedBy: doc.ownedBy,
      share: doc.share,
      createdAt: doc.createdAt as Instant,
      updatedAt: doc.updatedAt as Instant,
    });
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get id(): DashboardId {
    return this._id;
  }
  get name(): string {
    return this._name;
  }
  get description(): string {
    return this._description;
  }
  get layout(): DashboardLayout {
    return this._layout;
  }
  get refreshIntervalSec(): number {
    return this._refreshIntervalSec;
  }
  get widgets(): ReadonlyArray<Widget> {
    return this._widgets;
  }
  get ownedBy(): ActorRef {
    return this._ownedBy;
  }
  get share(): SharePolicy {
    return this._share;
  }
  get createdAt(): Instant {
    return this._createdAt;
  }
  get updatedAt(): Instant {
    return this._updatedAt;
  }
  get deleted(): boolean {
    return this._deleted;
  }

  /** Locate a widget by id. */
  findWidget(id: WidgetId): Widget | undefined {
    return this._widgets.find(w => w.id === id);
  }

  drainEvents(): DomainEvent<unknown>[] {
    return this._pendingEvents.splice(0, this._pendingEvents.length);
  }

  peekEvents(): ReadonlyArray<DomainEvent<unknown>> {
    return this._pendingEvents;
  }

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial update. Re-validates layout invariants on every
   * change so callers can swap widgets in a single call.
   */
  update(spec: DashboardUpdateSpec, clock: Clock): void {
    const changes: Record<string, unknown> = {};
    if (spec.name !== undefined) {
      const name = spec.name.trim();
      if (name.length === 0) {
        throw new ValidationError('dashboard name cannot be blank');
      }
      if (name !== this._name) {
        changes['name'] = name;
        this._name = name;
      }
    }
    if (spec.description !== undefined) {
      const desc = spec.description.trim();
      if (desc !== this._description) {
        changes['description'] = desc;
        this._description = desc;
      }
    }
    if (spec.layout !== undefined) {
      assertLayout(spec.layout);
      if (spec.layout !== this._layout) {
        changes['layout'] = spec.layout;
        this._layout = spec.layout;
      }
    }
    if (spec.refreshIntervalSec !== undefined) {
      assertRefreshInterval(spec.refreshIntervalSec);
      if (spec.refreshIntervalSec !== this._refreshIntervalSec) {
        changes['refreshIntervalSec'] = spec.refreshIntervalSec;
        this._refreshIntervalSec = spec.refreshIntervalSec;
      }
    }
    if (spec.widgets !== undefined) {
      const widgets = spec.widgets.map(w => Widget.create(w));
      if (this._layout === 'grid') {
        assertNoOverlap(widgets);
      }
      this._widgets = widgets;
      changes['widgets'] = widgets.length;
    } else if (spec.layout === 'grid') {
      // Layout flipped to grid → re-check overlaps.
      assertNoOverlap(this._widgets);
    }
    if (Object.keys(changes).length === 0) return;
    this._updatedAt = clock.nowInstant();
    this._emit('dashboard.updated', clock, {
      dashboardId: this._id,
      changes,
    });
  }

  /**
   * Replace the share policy. Always emits `dashboard.shared` even when
   * the policy is logically equivalent — operators may want the audit
   * trail of an explicit re-share.
   */
  shareWith(policy: SharePolicy, clock: Clock): void {
    assertSharePolicy(policy);
    this._share = {
      ...policy,
      ...(policy.roles ? { roles: [...policy.roles] } : {}),
    };
    this._updatedAt = clock.nowInstant();
    this._emit('dashboard.shared', clock, {
      dashboardId: this._id,
      with: {
        visibility: policy.visibility,
        ...(policy.roles ? { roles: [...policy.roles] } : {}),
      },
    });
  }

  /** Mark the aggregate as deleted; the service handles the repo delete. */
  markDeleted(clock: Clock): void {
    if (this._deleted) return;
    this._deleted = true;
    this._updatedAt = clock.nowInstant();
    this._emit('dashboard.deleted', clock, { dashboardId: this._id });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  toPersistence(): DashboardPersistence {
    return {
      id: this._id,
      name: this._name,
      description: this._description,
      layout: this._layout,
      refreshIntervalSec: this._refreshIntervalSec,
      widgets: this._widgets.map(w => w.toPersistence()),
      ownedBy: this._ownedBy,
      share: this._share,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private _emit(
    type:
      | 'dashboard.created'
      | 'dashboard.updated'
      | 'dashboard.deleted'
      | 'dashboard.shared',
    clock: Clock,
    payload: Record<string, unknown>
  ): void {
    this._pendingEvents.push(
      compose(
        {
          type,
          context: EVENT_CONTEXT,
          aggregateType: AGGREGATE_TYPE,
          aggregateId: this._id,
          actor: { type: 'user', id: this._ownedBy.userId },
          payload,
        },
        clock
      )
    );
  }
}
