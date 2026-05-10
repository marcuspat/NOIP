// Time primitives for the shared kernel. The `Clock` abstraction lets
// application code be tested deterministically.

/**
 * ISO-8601 timestamp string (e.g. `2026-05-10T12:34:56.789Z`).
 * Branded so it cannot be confused with arbitrary strings.
 */
export type Instant = string & { readonly _t: 'Instant' };

/**
 * Duration in milliseconds. Branded to avoid mixing units with
 * seconds, minutes, etc. at call sites.
 */
export type DurationMs = number & { readonly _t: 'DurationMs' };

export function asInstant(value: string | Date): Instant {
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso as Instant;
}

export function asDurationMs(ms: number): DurationMs {
  return ms as DurationMs;
}

export interface Clock {
  now(): Date;
  nowInstant(): Instant;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowInstant(): Instant {
    return new Date().toISOString() as Instant;
  }
}

/**
 * Test helper. Time only advances when the caller explicitly
 * calls `advance` or `set` — it does not tick on its own.
 */
export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date | string = new Date(0)) {
    this.current = initial instanceof Date ? initial : new Date(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  nowInstant(): Instant {
    return this.current.toISOString() as Instant;
  }

  set(date: Date | string): void {
    this.current = date instanceof Date ? date : new Date(date);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
