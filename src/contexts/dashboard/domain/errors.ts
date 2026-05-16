// Context-local error types. We extend the shared `DomainError` so the
// HTTP edge can keep using `toHttpResponse` without a special case.
//
// `NotImplementedError` is raised by the `WidgetDataResolver` when a
// branch that depends on a sibling context (e.g. Performance) is hit
// before that context is wired into the composition root. Mapping to
// 501 makes the limitation obvious to API callers.

import { DomainError } from '../../../shared/errors';

export class NotImplementedError extends DomainError {
  constructor(message = 'Not implemented', details?: Record<string, unknown>) {
    super(message, 'NOT_IMPLEMENTED', 501, details);
  }
}
