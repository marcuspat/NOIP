// WidgetDataResolver — fans a widget's `Datasource` out to the public
// API of the appropriate sibling context. The resolver is the *only*
// place inside the dashboard context that talks to another context, so
// the cross-context boundary is enforced by file location.
//
// Optimisation:
//   - Datasources are memoised per render cycle. A render cycle is the
//     lifespan of a single resolver instance: callers build one
//     resolver per dashboard render and discard it. The cache key is a
//     canonical JSON projection of the datasource (contextRef + query +
//     parameters), so two widgets pointing at the same datasource share
//     a single upstream call. This keeps a 20-widget dashboard fast
//     when half the widgets show the same data with different
//     visualisations.
//
// Failure isolation:
//   - Upstream errors bubble up unwrapped — the caller (ReportService
//     or HTTP route) decides whether to fail the whole render or skip
//     the widget. We intentionally do NOT swallow errors here.

import type { Clock, ClusterId } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import { NotImplementedError } from '../domain/errors';
import type { Widget } from '../domain/widget';
import type {
  Datasource,
  DatasourceContext,
  Scope,
  WidgetData,
  WidgetType,
} from '../domain/value-objects';

// ---------------------------------------------------------------------------
// Supplier shapes (structural). Each maps to the *public* API barrel of
// the corresponding context, but only the slice we actually call. Using
// structural shapes avoids a build-time import cycle when the dashboard
// context is compiled alone.
// ---------------------------------------------------------------------------

export interface DiscoverySupplier {
  getLatestSnapshot(scope: { clusterId: ClusterId }): Promise<{
    id: string;
    hash: string;
    takenAt: unknown;
    records: ReadonlyArray<{
      apiVersion: string;
      kind: string;
      namespace?: string;
      name: string;
    }>;
  }>;
}

export interface SecuritySupplier {
  getScore(scope: { clusterId: ClusterId }): Promise<{
    score: number;
    counts: {
      total: number;
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
  }>;
  listFindings(
    scope: { clusterId: ClusterId; namespace?: string },
    filter?: { limit?: number; severity?: unknown; status?: unknown }
  ): Promise<
    ReadonlyArray<{
      toPersistence(): Record<string, unknown>;
    }>
  >;
}

export interface CompliancePublicSlice {
  listFrameworks(): ReadonlyArray<string>;
  generateComplianceReport(
    framework: string,
    scope: { clusterId: ClusterId }
  ): Promise<{
    framework: string;
    overall: number;
    summary?: unknown;
  }>;
}

export interface AISupplier {
  getLatestInsights(
    scope: { clusterId: ClusterId },
    type?: unknown
  ): Promise<ReadonlyArray<{ id?: string; summary?: string }>>;
}

/**
 * Performance context isn't built yet. Once it lands, we'll expose
 * a slice like the others; until then the resolver throws
 * `NotImplementedError` on that branch.
 */
export interface PerformanceSupplier {
  // intentionally empty — placeholder for the sibling context
  getProbeSummary?(scope: { clusterId: ClusterId }): Promise<unknown>;
}

export interface ResolverSuppliers {
  discovery?: DiscoverySupplier;
  security?: SecuritySupplier;
  compliance?: CompliancePublicSlice;
  ai?: AISupplier;
  performance?: PerformanceSupplier;
}

export interface WidgetDataResolverDeps {
  suppliers: ResolverSuppliers;
  clock: Clock;
}

interface ResolveOpts {
  /** Optional scope hint that overrides whatever lives on `datasource.parameters`. */
  scope?: Scope;
}

/**
 * Canonical key for cache lookup. Object keys are sorted so two
 * structurally-equal datasources hash to the same string.
 */
function cacheKey(ds: Datasource): string {
  const parameters = ds.parameters ?? {};
  const sortedKeys = Object.keys(parameters).sort();
  const projected: Record<string, unknown> = {};
  for (const k of sortedKeys) projected[k] = parameters[k];
  return `${ds.contextRef}|${ds.query}|${JSON.stringify(projected)}`;
}

function readClusterId(
  ds: Datasource,
  opts?: ResolveOpts
): ClusterId | undefined {
  if (opts?.scope?.clusterId) return opts.scope.clusterId;
  const fromParams = ds.parameters?.['clusterId'];
  if (typeof fromParams === 'string' && fromParams.length > 0) {
    return fromParams as ClusterId;
  }
  return undefined;
}

function readNamespace(ds: Datasource, opts?: ResolveOpts): string | undefined {
  if (opts?.scope?.namespace) return opts.scope.namespace;
  const fromParams = ds.parameters?.['namespace'];
  if (typeof fromParams === 'string' && fromParams.length > 0)
    return fromParams;
  return undefined;
}

export class WidgetDataResolver {
  private readonly suppliers: ResolverSuppliers;
  private readonly clock: Clock;
  private readonly cache = new Map<string, Promise<WidgetData>>();

  constructor(deps: WidgetDataResolverDeps) {
    this.suppliers = deps.suppliers;
    this.clock = deps.clock;
  }

  /**
   * Resolve the data for a single widget. Idempotent within a single
   * resolver lifetime — repeated calls with the same datasource reuse
   * the in-flight promise, so a fan-out across N widgets that share a
   * datasource costs one upstream call.
   */
  async resolve(widget: Widget, opts: ResolveOpts = {}): Promise<WidgetData> {
    const ds = widget.datasource;
    const key = cacheKey(ds);
    const cached = this.cache.get(key);
    if (cached) {
      const reused = await cached;
      // Re-stamp `widgetType` from the calling widget so two widgets
      // with different visualisations against the same data still
      // declare their own type.
      return { ...reused, widgetType: widget.type };
    }
    const promise = this.dispatch(widget.type, ds, opts);
    this.cache.set(key, promise);
    return promise;
  }

  /**
   * Number of unique upstream calls served from this resolver's cache.
   * Test affordance; production callers ignore it.
   */
  cacheSize(): number {
    return this.cache.size;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private async dispatch(
    widgetType: WidgetType,
    ds: Datasource,
    opts: ResolveOpts
  ): Promise<WidgetData> {
    switch (ds.contextRef) {
      case 'discovery':
        return this.fromDiscovery(widgetType, ds, opts);
      case 'security':
        return this.fromSecurity(widgetType, ds, opts);
      case 'compliance':
        return this.fromCompliance(widgetType, ds, opts);
      case 'ai':
        return this.fromAI(widgetType, ds, opts);
      case 'performance':
        return this.fromPerformance(widgetType, ds, opts);
      default: {
        // Defence in depth: value-objects.ts enumerates the legal
        // values, but a malicious persisted doc could carry anything.
        const _exhaustive: never = ds.contextRef;
        void _exhaustive;
        throw new ValidationError('unknown datasource contextRef', {
          contextRef: ds.contextRef as DatasourceContext,
        });
      }
    }
  }

  private async fromDiscovery(
    widgetType: WidgetType,
    ds: Datasource,
    opts: ResolveOpts
  ): Promise<WidgetData> {
    if (!this.suppliers.discovery) {
      throw new NotImplementedError('discovery supplier not wired', {
        contextRef: 'discovery',
      });
    }
    const clusterId = readClusterId(ds, opts);
    if (!clusterId) {
      throw new ValidationError(
        'discovery widget requires a clusterId in parameters or scope'
      );
    }
    switch (ds.query) {
      case 'latestSnapshot': {
        const snap = await this.suppliers.discovery.getLatestSnapshot({
          clusterId,
        });
        return this.wrap(widgetType, {
          snapshotId: snap.id,
          hash: snap.hash,
          recordCount: snap.records.length,
        });
      }
      default:
        throw new ValidationError('unsupported discovery query', {
          query: ds.query,
        });
    }
  }

  private async fromSecurity(
    widgetType: WidgetType,
    ds: Datasource,
    opts: ResolveOpts
  ): Promise<WidgetData> {
    if (!this.suppliers.security) {
      throw new NotImplementedError('security supplier not wired', {
        contextRef: 'security',
      });
    }
    const clusterId = readClusterId(ds, opts);
    if (!clusterId) {
      throw new ValidationError(
        'security widget requires a clusterId in parameters or scope'
      );
    }
    switch (ds.query) {
      case 'score': {
        const s = await this.suppliers.security.getScore({ clusterId });
        return this.wrap(widgetType, s);
      }
      case 'findings': {
        const namespace = readNamespace(ds, opts);
        const limitRaw = ds.parameters?.['limit'];
        const limit =
          typeof limitRaw === 'number' && limitRaw > 0 ? limitRaw : 50;
        const findings = await this.suppliers.security.listFindings(
          { clusterId, ...(namespace !== undefined ? { namespace } : {}) },
          { limit }
        );
        return this.wrap(widgetType, {
          count: findings.length,
          items: findings.map(f => f.toPersistence()),
        });
      }
      default:
        throw new ValidationError('unsupported security query', {
          query: ds.query,
        });
    }
  }

  private async fromCompliance(
    widgetType: WidgetType,
    ds: Datasource,
    opts: ResolveOpts
  ): Promise<WidgetData> {
    if (!this.suppliers.compliance) {
      throw new NotImplementedError('compliance supplier not wired', {
        contextRef: 'compliance',
      });
    }
    switch (ds.query) {
      case 'frameworks':
        return this.wrap(widgetType, {
          frameworks: this.suppliers.compliance.listFrameworks(),
        });
      case 'report': {
        const clusterId = readClusterId(ds, opts);
        if (!clusterId) {
          throw new ValidationError(
            'compliance report widget requires a clusterId'
          );
        }
        const fwRaw = ds.parameters?.['framework'];
        if (typeof fwRaw !== 'string' || fwRaw.length === 0) {
          throw new ValidationError(
            'compliance report widget requires a framework parameter'
          );
        }
        const report = await this.suppliers.compliance.generateComplianceReport(
          fwRaw,
          {
            clusterId,
          }
        );
        return this.wrap(widgetType, {
          framework: report.framework,
          overall: report.overall,
        });
      }
      default:
        throw new ValidationError('unsupported compliance query', {
          query: ds.query,
        });
    }
  }

  private async fromAI(
    widgetType: WidgetType,
    ds: Datasource,
    opts: ResolveOpts
  ): Promise<WidgetData> {
    if (!this.suppliers.ai) {
      throw new NotImplementedError('ai supplier not wired', {
        contextRef: 'ai',
      });
    }
    const clusterId = readClusterId(ds, opts);
    if (!clusterId) {
      throw new ValidationError('ai widget requires a clusterId');
    }
    switch (ds.query) {
      case 'insights': {
        const type =
          typeof ds.parameters?.['type'] === 'string'
            ? (ds.parameters['type'] as string)
            : undefined;
        const insights = await this.suppliers.ai.getLatestInsights(
          { clusterId },
          type
        );
        return this.wrap(widgetType, { items: insights });
      }
      default:
        throw new ValidationError('unsupported ai query', {
          query: ds.query,
        });
    }
  }

  private async fromPerformance(
    widgetType: WidgetType,
    ds: Datasource,
    _opts: ResolveOpts
  ): Promise<WidgetData> {
    // The performance context is being built in parallel. Until its
    // public API lands the resolver short-circuits with a typed error
    // so the HTTP edge can return a clean 501.
    void widgetType;
    throw new NotImplementedError(
      'performance context public API is not available yet',
      { contextRef: 'performance', query: ds.query }
    );
  }

  private wrap(widgetType: WidgetType, payload: unknown): WidgetData {
    return {
      widgetType,
      payload,
      resolvedAt: this.clock.nowInstant(),
    };
  }
}
