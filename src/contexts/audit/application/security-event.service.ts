// SecurityEventService — application service that persists security
// events into the `securityEvents` collection.
//
// Per ADR-0018 every security-relevant `DomainEvent` should land here.
// The audit subscribers (`event-subscribers.ts`) wire this service to
// the EventBus; producers publish typed events instead of calling
// `record()` directly.
//
// Moved from `src/services/audit/security-event.service.ts` as part of
// DDD-11 bounded-context extraction. The old path keeps re-exporting
// from here so existing imports compile unchanged.

import {
  SecurityEventType,
  SecurityEventSeverity,
} from '../../../types/auth.types';

/** Logger surface limited to what this service uses. */
export interface SecurityEventLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal model surface so callers can pass either Mongoose's `Model` or
 * a stub for tests. The `Model.create` signature returns the persisted
 * document; we only inspect `_id` so the return type is loosened.
 */
export interface SecurityEventStore {
  create(input: SecurityEventPersistShape): Promise<{ _id: unknown }>;
}

/** Required input shape for `record`. */
export interface SecurityEventInput {
  type: SecurityEventType;
  description: string;
  ipAddress: string;
  userAgent: string;
  userId?: string;
  sessionId?: string;
  severity?: SecurityEventSeverity;
  details?: Record<string, unknown>;
}

/** What we actually hand to the store. Always includes a defaulted severity. */
export interface SecurityEventPersistShape {
  type: SecurityEventType;
  description: string;
  ipAddress: string;
  userAgent: string;
  severity: SecurityEventSeverity;
  resolved: boolean;
  userId?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

interface Deps {
  store: SecurityEventStore;
  logger: SecurityEventLogger;
}

/**
 * Defaults severity by event type. Mirrors common-sense bucketing used by
 * the SOC: failed-auth/anomaly = HIGH, sensitive-account-state = HIGH,
 * informational state = LOW, everything else MEDIUM.
 */
export function defaultSeverityFor(
  type: SecurityEventType
): SecurityEventSeverity {
  switch (type) {
    case SecurityEventType.LOGIN_SUCCESS:
    case SecurityEventType.LOGOUT:
    case SecurityEventType.MFA_VERIFICATION_SUCCESS:
      return SecurityEventSeverity.LOW;

    case SecurityEventType.LOGIN_FAILURE:
    case SecurityEventType.MFA_VERIFICATION_FAILURE:
    case SecurityEventType.SUSPICIOUS_LOGIN:
    case SecurityEventType.PERMISSION_ESCALATION:
      return SecurityEventSeverity.HIGH;

    case SecurityEventType.ACCOUNT_LOCKED:
    case SecurityEventType.MFA_DISABLED:
    case SecurityEventType.PASSWORD_CHANGE:
    case SecurityEventType.PASSWORD_RESET:
    case SecurityEventType.TOKEN_REVOKED:
      return SecurityEventSeverity.MEDIUM;

    default:
      return SecurityEventSeverity.MEDIUM;
  }
}

export class SecurityEventService {
  constructor(private readonly deps: Deps) {}

  /**
   * Persist a security event. Failures are logged and swallowed — the
   * caller's request path must never fail because the audit context is
   * unavailable. (Outbox-backed at-least-once delivery comes in Phase 2.)
   */
  async record(input: SecurityEventInput): Promise<void> {
    const persistShape: SecurityEventPersistShape = {
      type: input.type,
      description: input.description,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      severity: input.severity ?? defaultSeverityFor(input.type),
      resolved: false,
    };
    if (input.userId !== undefined) persistShape.userId = input.userId;
    if (input.sessionId !== undefined) persistShape.sessionId = input.sessionId;
    if (input.details !== undefined) persistShape.details = input.details;

    try {
      await this.deps.store.create(persistShape);
    } catch (err: unknown) {
      this.deps.logger.error('failed to persist security event', {
        eventType: input.type,
        userId: input.userId,
        ipAddress: input.ipAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
