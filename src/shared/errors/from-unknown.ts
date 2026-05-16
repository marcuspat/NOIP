// Helpers for narrowing the `unknown` type that TypeScript assigns to
// values caught in `catch` blocks (since TS 4.4 / strict catch typing).
//
// The repo-wide convention is:
//
//   } catch (err) {
//     logger.error('something blew up', { error: messageOf(err) });
//     throw err;
//   }
//
// — never `(err as Error).message` and never `as any`. This keeps the
// strictness on while giving us a one-call ergonomic for the 90% case
// (logging / re-throwing). For control flow (`instanceof DomainError`)
// use the helpers in `./index.ts`.

/**
 * Extracts a printable message from a value caught in a `catch` block.
 *
 * - `Error` instances return `error.message`.
 * - `{ message: string }` shapes return their message verbatim.
 * - Strings pass through.
 * - Everything else is `JSON.stringify`-ed; if that fails we fall back
 *   to `String(err)` so we never throw out of an error path.
 */
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Coerces an unknown value into an `Error` instance. Useful when an API
 * (e.g. logger) wants an `Error` for stack capture but the catch site
 * has `unknown`.
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(messageOf(err));
}
