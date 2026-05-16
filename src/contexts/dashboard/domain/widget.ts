// Widget value-aggregate.
//
// Widgets are owned by a `Dashboard` and have no independent lifecycle:
// the dashboard creates and removes them, and the aggregate's
// invariants are enforced via the parent. We expose `Widget` as its own
// class only to keep construction validation in one place — the
// aggregate methods on `Dashboard` (`addWidget`, `replaceWidget`) call
// the same factory.
//
// Invariants (DDD-10):
//   - `title` is non-empty after trim.
//   - `position` coordinates and dimensions are non-negative integers;
//     width / height must be strictly positive (no zero-sized widgets).
//   - `datasource.contextRef` is one of the published values.
//   - `refreshIntervalSec`, if set, is ≥ MIN_REFRESH_INTERVAL_SEC.

import { newId, type WidgetId } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';
import {
  MIN_REFRESH_INTERVAL_SEC,
  type Datasource,
  type DatasourceContext,
  type Position,
  type WidgetType,
} from './value-objects';

const SUPPORTED_TYPES: ReadonlySet<WidgetType> = new Set([
  'chart',
  'metric',
  'table',
  'alert',
]);

const SUPPORTED_CONTEXTS: ReadonlySet<DatasourceContext> = new Set([
  'discovery',
  'security',
  'compliance',
  'ai',
  'performance',
]);

export interface WidgetPersistence {
  id: string;
  type: WidgetType;
  title: string;
  datasource: Datasource;
  config: Record<string, unknown>;
  position: Position;
  refreshIntervalSec?: number;
}

export interface WidgetSpec {
  id?: WidgetId;
  type: WidgetType;
  title: string;
  datasource: Datasource;
  config?: Record<string, unknown>;
  position: Position;
  refreshIntervalSec?: number;
}

/**
 * Validates a candidate position. Throws `ValidationError` rather than
 * returning a boolean so call sites do not need to remember to wrap
 * results.
 */
export function assertPosition(p: Position): void {
  if (!p) throw new ValidationError('position is required');
  const fields: ReadonlyArray<keyof Position> = ['x', 'y', 'w', 'h'];
  for (const k of fields) {
    const v = p[k];
    if (!Number.isInteger(v) || v < 0) {
      throw new ValidationError('position coordinates must be ≥ 0 integers', {
        field: k,
        value: v,
      });
    }
  }
  if (p.w <= 0 || p.h <= 0) {
    throw new ValidationError('widget width/height must be > 0', {
      w: p.w,
      h: p.h,
    });
  }
}

/**
 * Returns true when two grid rectangles overlap. Uses the standard
 * half-open interval test: rects share area iff they overlap on both
 * the x and y axes.
 */
export function rectanglesOverlap(a: Position, b: Position): boolean {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return a.x < bx2 && b.x < ax2 && a.y < by2 && b.y < ay2;
}

export class Widget {
  private _id: WidgetId;
  private _type: WidgetType;
  private _title: string;
  private _datasource: Datasource;
  private _config: Record<string, unknown>;
  private _position: Position;
  private _refreshIntervalSec: number | undefined;

  private constructor(args: {
    id: WidgetId;
    type: WidgetType;
    title: string;
    datasource: Datasource;
    config: Record<string, unknown>;
    position: Position;
    refreshIntervalSec?: number;
  }) {
    this._id = args.id;
    this._type = args.type;
    this._title = args.title;
    this._datasource = args.datasource;
    this._config = args.config;
    this._position = args.position;
    this._refreshIntervalSec = args.refreshIntervalSec;
  }

  static create(spec: WidgetSpec): Widget {
    if (!SUPPORTED_TYPES.has(spec.type)) {
      throw new ValidationError('unsupported widget type', { type: spec.type });
    }
    const title = (spec.title ?? '').trim();
    if (title.length === 0) {
      throw new ValidationError('widget title is required');
    }
    if (
      !spec.datasource ||
      !SUPPORTED_CONTEXTS.has(spec.datasource.contextRef)
    ) {
      throw new ValidationError('unsupported datasource contextRef', {
        contextRef: spec.datasource?.contextRef,
      });
    }
    if (
      typeof spec.datasource.query !== 'string' ||
      spec.datasource.query.length === 0
    ) {
      throw new ValidationError('datasource query is required');
    }
    assertPosition(spec.position);
    if (
      spec.refreshIntervalSec !== undefined &&
      spec.refreshIntervalSec < MIN_REFRESH_INTERVAL_SEC
    ) {
      throw new ValidationError(
        `widget refreshIntervalSec must be ≥ ${MIN_REFRESH_INTERVAL_SEC}`,
        { refreshIntervalSec: spec.refreshIntervalSec }
      );
    }

    return new Widget({
      id: spec.id ?? newId<WidgetId>(),
      type: spec.type,
      title,
      datasource: { ...spec.datasource },
      config: { ...(spec.config ?? {}) },
      position: { ...spec.position },
      ...(spec.refreshIntervalSec !== undefined
        ? { refreshIntervalSec: spec.refreshIntervalSec }
        : {}),
    });
  }

  static fromPersistence(doc: WidgetPersistence): Widget {
    return new Widget({
      id: doc.id as WidgetId,
      type: doc.type,
      title: doc.title,
      datasource: doc.datasource,
      config: doc.config ?? {},
      position: doc.position,
      ...(doc.refreshIntervalSec !== undefined
        ? { refreshIntervalSec: doc.refreshIntervalSec }
        : {}),
    });
  }

  get id(): WidgetId {
    return this._id;
  }
  get type(): WidgetType {
    return this._type;
  }
  get title(): string {
    return this._title;
  }
  get datasource(): Datasource {
    return this._datasource;
  }
  get config(): Record<string, unknown> {
    return this._config;
  }
  get position(): Position {
    return this._position;
  }
  get refreshIntervalSec(): number | undefined {
    return this._refreshIntervalSec;
  }

  toPersistence(): WidgetPersistence {
    const out: WidgetPersistence = {
      id: this._id,
      type: this._type,
      title: this._title,
      datasource: this._datasource,
      config: this._config,
      position: this._position,
    };
    if (this._refreshIntervalSec !== undefined) {
      out.refreshIntervalSec = this._refreshIntervalSec;
    }
    return out;
  }
}
