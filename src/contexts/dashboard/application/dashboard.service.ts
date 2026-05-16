// DashboardService — application service for the Dashboard & Reporting
// context (DDD-10).
//
// Responsibilities:
//   - Drive the Dashboard aggregate's lifecycle: create / update /
//     delete / share.
//   - Resolve widget data on demand via `WidgetDataResolver` (memoised
//     per request).
//   - Enforce access via `AccessChecker`.
//   - Publish drained aggregate events on the bus *after* the
//     repository commits.

import type {
  Clock,
  DashboardId,
  EventBus,
  UserId,
  WidgetId,
} from '../../../shared/kernel';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../shared/errors';
import { AccessChecker, type Principal } from './access-checker';
import {
  Dashboard,
  type DashboardCreateSpec,
  type DashboardUpdateSpec,
} from '../domain/dashboard';
import type { SharePolicy, WidgetData } from '../domain/value-objects';
import type { DashboardRepository } from '../infrastructure/persistence/dashboard.repository';
import {
  WidgetDataResolver,
  type ResolverSuppliers,
} from './widget-data-resolver';

export interface DashboardServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: DashboardServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DashboardServiceDeps {
  repository: DashboardRepository;
  bus: EventBus;
  clock: Clock;
  suppliers: ResolverSuppliers;
  accessChecker?: AccessChecker;
  logger?: DashboardServiceLogger;
}

export interface DashboardCreateInput
  extends Omit<DashboardCreateSpec, 'ownedBy'> {
  ownedBy: { userId: UserId };
}

export interface WidgetDataRequest {
  dashboardId: DashboardId;
  widgetId: WidgetId;
  principal: Principal | null;
}

export class DashboardService {
  private readonly repository: DashboardRepository;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly suppliers: ResolverSuppliers;
  private readonly accessChecker: AccessChecker;
  private readonly logger: DashboardServiceLogger;

  constructor(deps: DashboardServiceDeps) {
    this.repository = deps.repository;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.suppliers = deps.suppliers;
    this.accessChecker = deps.accessChecker ?? new AccessChecker();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async createDashboard(input: DashboardCreateInput): Promise<Dashboard> {
    const dashboard = Dashboard.create(input, this.clock);
    await this.repository.save(dashboard);
    this.bus.publishMany(dashboard.drainEvents());
    this.logger.info('dashboard created', { id: dashboard.id });
    return dashboard;
  }

  async getDashboard(
    id: DashboardId,
    principal: Principal | null
  ): Promise<Dashboard> {
    const d = await this.repository.findById(id);
    if (!d) throw new NotFoundError('Dashboard', id);
    this.assertReadable(d, principal);
    return d;
  }

  async listDashboards(principal: Principal | null): Promise<Dashboard[]> {
    if (!principal) throw new UnauthorizedError();
    const all = await this.repository.findAll();
    return all.filter(d => this.accessChecker.canRead(d, principal));
  }

  async updateDashboard(
    id: DashboardId,
    spec: DashboardUpdateSpec,
    principal: Principal | null
  ): Promise<Dashboard> {
    const d = await this.repository.findById(id);
    if (!d) throw new NotFoundError('Dashboard', id);
    this.assertWritable(d, principal);
    d.update(spec, this.clock);
    await this.repository.save(d);
    this.bus.publishMany(d.drainEvents());
    return d;
  }

  async deleteDashboard(
    id: DashboardId,
    principal: Principal | null
  ): Promise<void> {
    const d = await this.repository.findById(id);
    if (!d) throw new NotFoundError('Dashboard', id);
    this.assertWritable(d, principal);
    d.markDeleted(this.clock);
    const events = d.drainEvents();
    await this.repository.delete(id);
    this.bus.publishMany(events);
  }

  async share(
    id: DashboardId,
    policy: SharePolicy,
    principal: Principal | null
  ): Promise<Dashboard> {
    const d = await this.repository.findById(id);
    if (!d) throw new NotFoundError('Dashboard', id);
    this.assertWritable(d, principal);
    d.shareWith(policy, this.clock);
    await this.repository.save(d);
    this.bus.publishMany(d.drainEvents());
    return d;
  }

  // ---------------------------------------------------------------------------
  // Widget data
  // ---------------------------------------------------------------------------

  /**
   * Resolves a single widget's data. Builds a fresh
   * `WidgetDataResolver` per call so the in-flight cache is scoped to
   * this request.
   */
  async getWidgetData(req: WidgetDataRequest): Promise<WidgetData> {
    const d = await this.repository.findById(req.dashboardId);
    if (!d) throw new NotFoundError('Dashboard', req.dashboardId);
    this.assertReadable(d, req.principal);
    const widget = d.findWidget(req.widgetId);
    if (!widget) throw new NotFoundError('Widget', req.widgetId);
    const resolver = this.newResolver();
    return resolver.resolve(widget);
  }

  /**
   * Resolve all widgets in one go, sharing the per-render cache so
   * sibling widgets that read the same datasource only cost one
   * upstream call. Used by the executive-summary / posture renderers.
   */
  async getAllWidgetData(
    dashboardId: DashboardId,
    principal: Principal | null
  ): Promise<Map<WidgetId, WidgetData>> {
    const d = await this.repository.findById(dashboardId);
    if (!d) throw new NotFoundError('Dashboard', dashboardId);
    this.assertReadable(d, principal);
    const resolver = this.newResolver();
    const out = new Map<WidgetId, WidgetData>();
    // Run sequentially in source order so the cache wins; parallel
    // dispatch would still work but lose the memoisation benefit on
    // the first wave of identical datasources.
    for (const widget of d.widgets) {
      const data = await resolver.resolve(widget);
      out.set(widget.id, data);
    }
    return out;
  }

  /** Build a new resolver. Exposed for the report service. */
  newResolver(): WidgetDataResolver {
    return new WidgetDataResolver({
      suppliers: this.suppliers,
      clock: this.clock,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private assertReadable(
    dashboard: Dashboard,
    principal: Principal | null
  ): void {
    if (!principal) throw new UnauthorizedError();
    if (!this.accessChecker.canRead(dashboard, principal)) {
      throw new ForbiddenError('cannot read dashboard', {
        dashboardId: dashboard.id,
      });
    }
  }

  private assertWritable(
    dashboard: Dashboard,
    principal: Principal | null
  ): void {
    if (!principal) throw new UnauthorizedError();
    if (!this.accessChecker.canWrite(dashboard, principal)) {
      throw new ForbiddenError('cannot mutate dashboard', {
        dashboardId: dashboard.id,
      });
    }
  }
}

/**
 * Type narrower used by the HTTP layer when it has only the raw body.
 * Kept here so the route file doesn't have to import the domain
 * validators directly.
 */
export function requirePrincipal(p: Principal | null): Principal {
  if (!p) throw new UnauthorizedError();
  if (!p.userId) throw new ValidationError('userId is required');
  return p;
}
