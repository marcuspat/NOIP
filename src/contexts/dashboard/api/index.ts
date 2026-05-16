// Public API barrel for the Dashboard & Reporting context (DDD-10).
// Per ADR-0011 cross-context callers MUST only import from this module.
//
// What we expose:
//   - The `DashboardPublicApi` interface — the slice every other
//     context can call.
//   - Aggregate + value-object types needed by downstream callers and
//     tests.
//   - The `composeDashboard` factory that wires the application
//     service for the composition root.
//   - The HTTP router factories.
//
// Anything not re-exported here is private to the context.

import type { Router } from 'express';
import type { Clock, DashboardId, EventBus } from '../../../shared/kernel';
import {
  DashboardService,
  type DashboardServiceLogger,
} from '../application/dashboard.service';
import {
  ReportService,
  type ReportServiceLogger,
} from '../application/report.service';
import { AccessChecker } from '../application/access-checker';
import type { ResolverSuppliers } from '../application/widget-data-resolver';
import {
  InMemoryDashboardRepository,
  MongooseDashboardRepository,
  type DashboardRepository,
} from '../infrastructure/persistence/dashboard.repository';
import {
  InMemoryReportRepository,
  MongooseReportRepository,
  type ReportRepository,
} from '../infrastructure/persistence/report.repository';
import { JsonReportRenderer } from '../infrastructure/renderer/json-renderer';
import { CsvReportRenderer } from '../infrastructure/renderer/csv-renderer';
import { HtmlReportRenderer } from '../infrastructure/renderer/html-renderer';
import {
  PdfReportRenderer,
  type ChromiumFactory,
} from '../infrastructure/renderer/pdf-renderer';
import {
  createObjectStorageAdapter,
  type CreateObjectStorageAdapterOpts,
} from '../infrastructure/object-storage/object-storage-adapter';
import dashboardRoutesFactory from '../http/dashboard.routes';
import reportRoutesFactory from '../http/report.routes';
import type { Dashboard } from '../domain/dashboard';
import type { Report } from '../domain/report';
import type { Format, ReportKind, Scope } from '../domain/value-objects';
import type { ObjectStorageAdapter } from '../domain/ports/object-storage';
import type { ReportRenderer } from '../domain/ports/report-renderer';
import type { Principal } from '../application/access-checker';

// ---------------------------------------------------------------------------
// Re-exports (domain + application surface)
// ---------------------------------------------------------------------------

export { Dashboard } from '../domain/dashboard';
export type {
  DashboardCreateSpec,
  DashboardPersistence,
  DashboardUpdateSpec,
} from '../domain/dashboard';
export { Widget, rectanglesOverlap, assertPosition } from '../domain/widget';
export type { WidgetPersistence, WidgetSpec } from '../domain/widget';
export { Report } from '../domain/report';
export type {
  ReportPersistence,
  ReportQueueSpec,
  ReportStatus,
  ReportSucceedSpec,
} from '../domain/report';
export type {
  ActorRef,
  DashboardLayout,
  Datasource,
  DatasourceContext,
  Format,
  Position,
  ReportKind,
  Scope,
  SharePolicy,
  ShareVisibility,
  WidgetData,
  WidgetType,
} from '../domain/value-objects';
export { MIN_REFRESH_INTERVAL_SEC } from '../domain/value-objects';
export { NotImplementedError } from '../domain/errors';

export { DashboardService } from '../application/dashboard.service';
export type {
  DashboardServiceDeps,
  DashboardServiceLogger,
  DashboardCreateInput,
  WidgetDataRequest,
} from '../application/dashboard.service';
export { ReportService } from '../application/report.service';
export type {
  GenerateReportInput,
  ReportServiceDeps,
  ReportServiceLogger,
} from '../application/report.service';
export { AccessChecker } from '../application/access-checker';
export type { Principal } from '../application/access-checker';
export {
  WidgetDataResolver,
  type AISupplier,
  type CompliancePublicSlice,
  type DiscoverySupplier,
  type PerformanceSupplier,
  type ResolverSuppliers,
  type SecuritySupplier,
} from '../application/widget-data-resolver';

export {
  InMemoryDashboardRepository,
  MongooseDashboardRepository,
  type DashboardRepository,
} from '../infrastructure/persistence/dashboard.repository';
export {
  InMemoryReportRepository,
  MongooseReportRepository,
  type ReportRepository,
  type ReportListFilter,
} from '../infrastructure/persistence/report.repository';

export { JsonReportRenderer } from '../infrastructure/renderer/json-renderer';
export { CsvReportRenderer } from '../infrastructure/renderer/csv-renderer';
export {
  HtmlReportRenderer,
  escapeHtml,
  renderHtmlString,
} from '../infrastructure/renderer/html-renderer';
export {
  PdfReportRenderer,
  type ChromiumFactory,
  type ChromiumPdfPipeline,
} from '../infrastructure/renderer/pdf-renderer';
export {
  LocalFsObjectStorageAdapter,
  type LocalFsStorageAdapterOpts,
} from '../infrastructure/object-storage/local-fs-storage-adapter';
export {
  createObjectStorageAdapter,
  defaultDashboardS3Factory,
  S3ObjectStorageAdapter,
  type CreateObjectStorageAdapterOpts,
  type DashboardS3Env,
  type DashboardS3Factory,
  type S3ClientLike,
  type S3ObjectStorageAdapterOpts,
} from '../infrastructure/object-storage/object-storage-adapter';
export { buildReportKey } from '../domain/ports/object-storage';
export type {
  ObjectPutOpts,
  ObjectPutResult,
  ObjectStorageAdapter,
} from '../domain/ports/object-storage';
export type {
  RenderInput,
  RenderPanel,
  RenderResult,
  ReportRenderer,
} from '../domain/ports/report-renderer';

export { dashboardRoutes } from '../http/dashboard.routes';
export { reportRoutes } from '../http/report.routes';

// ---------------------------------------------------------------------------
// Public API contract per DDD-10
// ---------------------------------------------------------------------------

export interface DashboardPublicApi {
  getDashboard(
    id: DashboardId,
    principal: Principal | null
  ): Promise<Dashboard | null>;
  generateReport(
    kind: ReportKind,
    scope: Scope,
    format: Format,
    principal: Principal
  ): Promise<Report>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ComposeDashboardLogger
  extends DashboardServiceLogger,
    ReportServiceLogger {}

export interface ComposeDashboardDeps {
  bus: EventBus;
  clock: Clock;
  logger?: ComposeDashboardLogger;
  /** Sibling-context public APIs. Each is optional so tests can wire
   * only what they need; the resolver throws `NotImplementedError`
   * for branches whose supplier wasn't provided. */
  suppliers?: ResolverSuppliers;
  /** Override repositories (tests). Defaults to Mongoose-backed. */
  repos?: {
    dashboards?: DashboardRepository;
    reports?: ReportRepository;
  };
  /** Override the object-storage adapter. Defaults to
   * `createObjectStorageAdapter()` which prefers S3 when configured
   * and falls back to local-fs. */
  storage?: ObjectStorageAdapter;
  storageOpts?: CreateObjectStorageAdapterOpts;
  /** Override the renderer registry. Defaults to JSON+CSV+HTML+PDF. */
  renderers?: ReadonlyArray<ReportRenderer>;
  /** Optional Chromium pipeline factory for the PDF renderer. */
  chromiumFactory?: ChromiumFactory;
  /** When true (the default) use Mongoose repos; tests pass `false`
   * to swap in the in-memory variants without touching Mongo. */
  useInMemoryRepos?: boolean;
}

export interface ComposedDashboard {
  service: DashboardService;
  reportService: ReportService;
  accessChecker: AccessChecker;
  publicApi: DashboardPublicApi;
  routers: {
    dashboard: Router;
    report: Router;
  };
  storage: ObjectStorageAdapter;
  renderers: ReadonlyArray<ReportRenderer>;
}

/**
 * Wire the dashboard context. The composition root passes:
 *   - shared kernel `bus`, `clock`, and an optional logger;
 *   - sibling-context public APIs as `suppliers` (Discovery, Security,
 *     Compliance, AI; Performance once it lands);
 *   - optional overrides for storage / renderers.
 *
 * The factory builds a single `DashboardService`, `ReportService`,
 * Express routers, and a `DashboardPublicApi` slice for downstream
 * contexts (currently no one consumes it, but the contract is
 * published).
 */
export function composeDashboard(
  deps: ComposeDashboardDeps
): ComposedDashboard {
  const useInMemory = deps.useInMemoryRepos ?? false;
  const dashboards =
    deps.repos?.dashboards ??
    (useInMemory
      ? new InMemoryDashboardRepository()
      : new MongooseDashboardRepository());
  const reports =
    deps.repos?.reports ??
    (useInMemory
      ? new InMemoryReportRepository()
      : new MongooseReportRepository());

  const storage =
    deps.storage ?? createObjectStorageAdapter(deps.storageOpts ?? {});

  const renderers: ReadonlyArray<ReportRenderer> = deps.renderers ?? [
    new JsonReportRenderer(),
    new CsvReportRenderer(),
    new HtmlReportRenderer(),
    new PdfReportRenderer(
      deps.chromiumFactory ? { factory: deps.chromiumFactory } : {}
    ),
  ];

  const accessChecker = new AccessChecker();

  const service = new DashboardService({
    repository: dashboards,
    bus: deps.bus,
    clock: deps.clock,
    suppliers: deps.suppliers ?? {},
    accessChecker,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const reportService = new ReportService({
    repository: reports,
    storage,
    renderers,
    bus: deps.bus,
    clock: deps.clock,
    dashboardService: service,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const publicApi: DashboardPublicApi = {
    getDashboard: async (id, principal) => {
      try {
        return await service.getDashboard(id, principal);
      } catch (err) {
        // A read miss / forbid surfaces as `null` for cross-context
        // callers — they don't get the privilege of an exception
        // bubble across the boundary.
        const code = (err as { code?: string }).code;
        if (
          code === 'NOT_FOUND' ||
          code === 'FORBIDDEN' ||
          code === 'UNAUTHORIZED'
        ) {
          return null;
        }
        throw err;
      }
    },
    generateReport: (kind, scope, format, principal) =>
      reportService.generateReport({
        kind,
        scope,
        format,
        generatedBy: { userId: principal.userId },
      }),
  };

  return {
    service,
    reportService,
    accessChecker,
    publicApi,
    routers: {
      dashboard: dashboardRoutesFactory(service),
      report: reportRoutesFactory(reportService),
    },
    storage,
    renderers,
  };
}

// Re-export the underlying request/report ids so downstream consumers
// don't have to dig into the shared kernel just to talk to us.
export type { DashboardId, ReportId } from '../../../shared/kernel';
