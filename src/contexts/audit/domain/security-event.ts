// Re-export of the `SecurityEvent` aggregate shape.
//
// The Mongoose model in `src/models/security-event.model.ts` is the
// canonical source. Living under `domain/` here lets context-internal
// callers reach the type via a stable path even if the persistence
// path moves.

export type {
  SecurityEventDocument,
  SecurityEventModelType,
} from '../../../models/security-event.model';
export { SecurityEventModel } from '../../../models/security-event.model';
export {
  SecurityEventType,
  SecurityEventSeverity,
  type SecurityEvent,
} from '../../../types/auth.types';
