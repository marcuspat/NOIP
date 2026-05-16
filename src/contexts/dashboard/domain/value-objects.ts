// Value objects for the Dashboard & Reporting context (DDD-10).
//
// Pure data shapes — no behaviour, no persistence concerns. The
// application layer composes these; aggregates enforce invariants on
// top of them.
//
// The shapes intentionally mirror the legacy `DashboardConfig` /
// `DashboardWidget` so the existing front-end and integration suites
// keep working after the cutover.

import type { ClusterId, UserId } from '../../../shared/kernel';

/**
 * Layout strategy applied by the front-end. `grid` enforces a 12-column
 * positional model and prevents widgets from overlapping; `flex` is a
 * free-form layout and only enforces non-negative positions.
 */
export type DashboardLayout = 'grid' | 'flex';

/**
 * Supported widget kinds. The renderer chooses a different shape per
 * kind; the dashboard service only cares that a widget points at a
 * datasource that resolves.
 */
export type WidgetType = 'chart' | 'metric' | 'table' | 'alert';

/**
 * Format of a generated report artifact. PDF requires an HTML render
 * plus a Chromium pipeline; CSV / JSON are stream-friendly.
 */
export type Format = 'pdf' | 'html' | 'json' | 'csv';

/**
 * Catalogue of canned reports. Each kind has a different scope shape
 * and a different default widget set inside the renderer.
 */
export type ReportKind =
  | 'executive_summary'
  | 'posture'
  | 'compliance'
  | 'incident';

/**
 * Visibility on a dashboard's `SharePolicy`. `role-scoped` carries a
 * non-empty `roles` list; the access checker enforces the role match.
 */
export type ShareVisibility = 'private' | 'role-scoped' | 'organisation';

/**
 * Grid position. Coordinates are non-negative integer cells; `w` and
 * `h` are the widget's footprint. Aggregates reject negative or zero
 * dimensions at construction time.
 */
export interface Position {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Reference to which context owns the data a widget renders. The
 * `WidgetDataResolver` switches on `contextRef` to dispatch to the
 * right public API.
 */
export type DatasourceContext =
  | 'discovery'
  | 'security'
  | 'compliance'
  | 'ai'
  | 'performance';

/**
 * Pointer into another context's read API. The resolver treats this as
 * an opaque contract — it does not interpret `query` or `parameters`
 * beyond passing them to the supplier.
 */
export interface Datasource {
  contextRef: DatasourceContext;
  query: string;
  parameters?: Record<string, unknown>;
}

/**
 * Identifier of an actor. We re-use `UserId` from the shared kernel so
 * the audit pipeline can correlate dashboard activity with the IAM
 * context's user identities.
 */
export interface ActorRef {
  userId: UserId;
}

/**
 * Policy that gates dashboard reads. Role-scoped shares carry an
 * explicit role list; private dashboards are visible only to their
 * owner; organisation-wide is the broadest grant.
 */
export interface SharePolicy {
  visibility: ShareVisibility;
  roles?: ReadonlyArray<string>;
}

/**
 * Bounded query envelope for a report. The renderer reads it; the
 * report service only stores it for traceability.
 */
export interface Scope {
  clusterId?: ClusterId;
  namespace?: string;
  framework?: string;
  windowDays?: number;
}

/**
 * Shaped data returned by `WidgetDataResolver`. The renderer expects
 * one of these per widget; downstream code projects them onto the
 * legacy chart.js / table shapes.
 */
export interface WidgetData {
  widgetType: WidgetType;
  payload: unknown;
  resolvedAt: string;
}

/**
 * Domain-level signal that the AWS SDK (or another optional
 * dependency) isn't installed. The composition root and the report
 * renderer use this to fall back gracefully.
 */
export const MIN_REFRESH_INTERVAL_SEC = 30;
