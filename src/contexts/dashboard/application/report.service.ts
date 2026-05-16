// ReportService — generates and persists Report aggregates.
//
// Pipeline for `generateReport`:
//   1. Build a queued `Report` aggregate and persist it. The row is
//      visible immediately so the caller can poll.
//   2. Build a `RenderInput` from the report kind + scope. Inputs vary
//      by kind — see `composeInput` below.
//   3. Pick the matching renderer from the registered list.
//   4. Stream the artifact through the object-storage adapter.
//   5. Stamp `markGenerated` on the aggregate, persist, and publish
//      `report.generated`.
//
// Failures along the way mark the report `failed` and persist the
// reason; we do not publish `report.generated` for failures (DDD-12
// `report.generated` is success-only).

import type { Readable } from 'node:stream';
import {
  type Clock,
  type EventBus,
  type ReportId,
  type UserId,
} from '../../../shared/kernel';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../shared/errors';
import { Report } from '../domain/report';
import type {
  Format,
  ReportKind,
  Scope,
  WidgetData,
} from '../domain/value-objects';
import type {
  ReportRenderer,
  RenderInput,
  RenderPanel,
  RenderResult,
} from '../domain/ports/report-renderer';
import {
  buildReportKey,
  type ObjectStorageAdapter,
} from '../domain/ports/object-storage';
import type {
  ReportListFilter,
  ReportRepository,
} from '../infrastructure/persistence/report.repository';
import type { Principal } from './access-checker';
import type { DashboardService } from './dashboard.service';

export interface ReportServiceLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: ReportServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ReportServiceDeps {
  repository: ReportRepository;
  storage: ObjectStorageAdapter;
  renderers: ReadonlyArray<ReportRenderer>;
  bus: EventBus;
  clock: Clock;
  /** Optional — used to source widget data for `posture` / `executive_summary`. */
  dashboardService?: DashboardService;
  logger?: ReportServiceLogger;
}

export interface GenerateReportInput {
  kind: ReportKind;
  scope: Scope;
  format: Format;
  generatedBy: { userId: UserId };
  /** Optional payload bundle. When omitted the service builds a default. */
  panels?: ReadonlyArray<RenderPanel>;
  /** Optional title override. */
  title?: string;
}

const KIND_TITLES: Readonly<Record<ReportKind, string>> = {
  executive_summary: 'Executive Summary',
  posture: 'Security Posture',
  compliance: 'Compliance Report',
  incident: 'Incident Report',
};

export class ReportService {
  private readonly repository: ReportRepository;
  private readonly storage: ObjectStorageAdapter;
  private readonly renderers: ReadonlyArray<ReportRenderer>;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly logger: ReportServiceLogger;

  constructor(deps: ReportServiceDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.renderers = deps.renderers;
    this.bus = deps.bus;
    this.clock = deps.clock;
    // Kept on the deps surface for future kind-specific compositions
    // (executive_summary / posture would pull panels from the
    // dashboard's widgets). Currently no read uses this — touch keeps
    // the linter quiet.
    void deps.dashboardService;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  async generateReport(input: GenerateReportInput): Promise<Report> {
    if (!input.generatedBy?.userId)
      throw new ValidationError('userId required');

    const renderer = this.rendererFor(input.format);
    const report = Report.queued(
      {
        kind: input.kind,
        scope: input.scope,
        format: input.format,
        generatedBy: input.generatedBy,
      },
      this.clock
    );
    await this.repository.save(report);

    try {
      const panels = input.panels ?? (await this.composeDefaultPanels(input));
      const renderInput: RenderInput = {
        kind: input.kind,
        scope: input.scope,
        format: input.format,
        generatedAt: this.clock.nowInstant(),
        title: input.title ?? KIND_TITLES[input.kind],
        panels,
      };
      const rendered = await renderer.render(renderInput);
      const upload = await this.upload(report.id, rendered);
      report.markGenerated(
        {
          artifactUri: upload.uri,
          artifactKey: upload.key,
          artifactSize: upload.size,
        },
        this.clock
      );
      await this.repository.save(report);
      this.bus.publishMany(report.drainEvents());
      this.logger.info('report generated', {
        id: report.id,
        kind: input.kind,
        format: input.format,
        size: upload.size,
      });
      return report;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.markFailed(reason, this.clock);
      await this.repository.save(report);
      this.logger.error('report render failed', {
        id: report.id,
        error: reason,
      });
      throw err;
    }
  }

  async getReport(id: ReportId, principal: Principal | null): Promise<Report> {
    if (!principal) throw new UnauthorizedError();
    const r = await this.repository.findById(id);
    if (!r) throw new NotFoundError('Report', id);
    return r;
  }

  async listReports(
    filter: ReportListFilter,
    principal: Principal | null
  ): Promise<Report[]> {
    if (!principal) throw new UnauthorizedError();
    return this.repository.list(filter);
  }

  /**
   * Returns a readable stream over the artifact bytes plus its
   * persisted metadata. The HTTP edge sets headers + pipes it.
   */
  async getArtifact(
    id: ReportId,
    principal: Principal | null
  ): Promise<{ report: Report; stream: Readable; key: string }> {
    if (!principal) throw new UnauthorizedError();
    const r = await this.repository.findById(id);
    if (!r) throw new NotFoundError('Report', id);
    if (r.status !== 'generated' || !r.artifactUri || !r.artifactKey) {
      throw new NotFoundError('ReportArtifact', id);
    }
    const key = r.artifactKey;
    const stream = await this.storage.getStream(key);
    return { report: r, stream, key };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private rendererFor(format: Format): ReportRenderer {
    for (const r of this.renderers) if (r.supports(format)) return r;
    throw new ValidationError('no renderer registered for format', { format });
  }

  /**
   * Build a panel list with no widget binding. Used when the caller
   * doesn't supply `panels`. The current implementation produces a
   * placeholder panel summarising the scope so the renderer still has
   * something to draw; richer compositions land per-kind in a later
   * iteration.
   */
  private async composeDefaultPanels(
    input: GenerateReportInput
  ): Promise<RenderPanel[]> {
    const placeholder: WidgetData = {
      widgetType: 'metric',
      payload: { kind: input.kind, scope: input.scope },
      resolvedAt: this.clock.nowInstant(),
    };
    return [
      {
        id: 'overview',
        title: KIND_TITLES[input.kind],
        data: placeholder,
      },
    ];
  }

  /**
   * Uploads via streaming when the renderer supports it; otherwise we
   * buffer first. The `buildReportKey` helper gives the artifact a
   * deterministic location.
   */
  private async upload(
    reportId: ReportId,
    rendered: RenderResult
  ): Promise<{ uri: string; key: string; size: number }> {
    const generatedAt = this.clock.now();
    const key = buildReportKey({
      reportId,
      generatedAt,
      extension: rendered.extension,
    });
    const result = await this.storage.putStream(key, rendered.stream(), {
      contentType: rendered.contentType,
    });
    return { uri: result.uri, key, size: result.size };
  }
}
