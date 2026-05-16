// Widget value-aggregate unit tests.

import {
  Widget,
  assertPosition,
  rectanglesOverlap,
} from '../../../src/contexts/dashboard/domain/widget';
import { ValidationError } from '../../../src/shared/errors';
import type { WidgetSpec } from '../../../src/contexts/dashboard/domain/widget';

function spec(overrides: Partial<WidgetSpec> = {}): WidgetSpec {
  return {
    type: 'metric',
    title: 'CPU',
    datasource: { contextRef: 'security', query: 'score' },
    config: {},
    position: { x: 0, y: 0, w: 3, h: 2 },
    ...overrides,
  };
}

describe('Widget aggregate', () => {
  it('create() rejects an unsupported widget type', () => {
    expect(() => Widget.create(spec({ type: 'pie-chart' as never }))).toThrow(
      ValidationError
    );
  });

  it('create() rejects a blank title', () => {
    expect(() => Widget.create(spec({ title: '   ' }))).toThrow(
      ValidationError
    );
  });

  it('create() rejects a missing datasource query', () => {
    expect(() =>
      Widget.create(spec({ datasource: { contextRef: 'security', query: '' } }))
    ).toThrow(ValidationError);
  });

  it('create() rejects an unsupported datasource contextRef', () => {
    expect(() =>
      Widget.create(
        spec({
          datasource: {
            contextRef: 'mystery' as never,
            query: 'score',
          },
        })
      )
    ).toThrow(ValidationError);
  });

  it('create() rejects refreshIntervalSec below the floor', () => {
    expect(() => Widget.create(spec({ refreshIntervalSec: 10 }))).toThrow(
      /refreshIntervalSec/
    );
  });

  it('round-trips via toPersistence / fromPersistence', () => {
    const original = Widget.create(spec({ refreshIntervalSec: 60 }));
    const reloaded = Widget.fromPersistence(original.toPersistence());
    expect(reloaded.id).toBe(original.id);
    expect(reloaded.title).toBe(original.title);
    expect(reloaded.refreshIntervalSec).toBe(60);
    expect(reloaded.position).toEqual(original.position);
  });

  it('trims the title on create', () => {
    const w = Widget.create(spec({ title: '  My Widget  ' }));
    expect(w.title).toBe('My Widget');
  });

  it('clones config and datasource so the caller cannot mutate after create', () => {
    const config = { foo: 'bar' };
    const ds = { contextRef: 'security' as const, query: 'score' };
    const w = Widget.create(spec({ config, datasource: ds }));
    (config as Record<string, unknown>)['foo'] = 'mutated';
    expect(w.config['foo']).toBe('bar');
  });
});

describe('assertPosition', () => {
  it('rejects negative x', () => {
    expect(() => assertPosition({ x: -1, y: 0, w: 1, h: 1 })).toThrow(
      ValidationError
    );
  });

  it('rejects zero width or height', () => {
    expect(() => assertPosition({ x: 0, y: 0, w: 0, h: 1 })).toThrow(
      ValidationError
    );
    expect(() => assertPosition({ x: 0, y: 0, w: 1, h: 0 })).toThrow(
      ValidationError
    );
  });

  it('rejects non-integer coordinates', () => {
    expect(() => assertPosition({ x: 0.5, y: 0, w: 1, h: 1 })).toThrow(
      ValidationError
    );
  });

  it('accepts a valid position', () => {
    expect(() => assertPosition({ x: 0, y: 0, w: 1, h: 1 })).not.toThrow();
  });
});

describe('rectanglesOverlap', () => {
  it('returns false for fully disjoint rectangles', () => {
    expect(
      rectanglesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })
    ).toBe(false);
  });

  it('returns false for touching edges', () => {
    expect(
      rectanglesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })
    ).toBe(false);
  });

  it('returns true when one contains the other', () => {
    expect(
      rectanglesOverlap({ x: 0, y: 0, w: 4, h: 4 }, { x: 1, y: 1, w: 1, h: 1 })
    ).toBe(true);
  });

  it('returns true for partial overlap', () => {
    expect(
      rectanglesOverlap({ x: 0, y: 0, w: 3, h: 3 }, { x: 2, y: 2, w: 3, h: 3 })
    ).toBe(true);
  });
});
