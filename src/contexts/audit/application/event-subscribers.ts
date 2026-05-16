// Audit context subscribers (ADR-0018 Phase 1 wave 2).
//
// Wires the in-process EventBus to the two audit-side persistence paths:
//
//   1. Security events — every `iam.*`, `security.*`, `compliance.*`,
//      `discovery.*`, `ai.*`, `performance.*`, and `dashboard.*` event
//      maps onto a `SecurityEventInput` and is persisted via
//      `SecurityEventService.record`.
//   2. Audit log entries — `audit.request` events (published by the audit
//      middleware) are persisted via `HashChainAppender.append`.
//   3. Chain breaks — `audit.chain.broken` is logged at error level. The
//      appender that emitted the event already wrote a structured log
//      line; this is a redundant safety net so subscribers see the
//      signal even if the appender's logger is muted.
//
// Subscribers are deliberately fire-and-forget: handlers `void` the
// async record/append calls and attach a `.catch(logger.error)` so the
// in-process EventBus never blocks producers waiting on persistence.
//
// Optimisation: each top-level domain registers exactly one trailing-`*`
// subscription. A finer-grained fan-out (per `iam.session.opened` etc.)
// would cost N subscriptions per producer and force each new event type
// to update the wiring; the current shape needs no edits when new IAM
// events land, only new mapping rules in `toSecurityEventInput`.
//
// Moved from `src/services/audit/event-subscribers.ts` as part of DDD-11.

import {
  SecurityEventType,
  SecurityEventSeverity,
} from '../../../types/auth.types';
import type {
  DomainEvent,
  EventBus,
  Unsubscribe,
} from '../../../shared/kernel';
import type {
  HashChainAppender,
  AuditEntryInput,
} from './hash-chain-appender.service';
import type {
  SecurityEventInput,
  SecurityEventService,
} from './security-event.service';

/** Logger surface — subset of the kernel `EventBusLogger`. */
export interface AuditSubscribersLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
}

export interface InstallAuditSubscribersDeps {
  bus: EventBus;
  securityEvents: SecurityEventService;
  appender: HashChainAppender;
  logger: AuditSubscribersLogger;
}

/**
 * Top-level domain prefixes that get fanned out to
 * `securityEvents.record`. Adding a new domain is a one-line change.
 */
const SECURITY_EVENT_DOMAINS: ReadonlyArray<string> = [
  'iam.',
  'security.',
  'compliance.',
  'discovery.',
  'ai.',
  'performance.',
  'dashboard.',
];

/**
 * Wires every audit-context subscriber to the bus and returns the
 * unsubscribe handles so tests can tear things down between cases.
 *
 * Sync delivery semantics are preserved — subscribers schedule their
 * async work via `void` and a `.catch`. The bus' own error capture is
 * the second line of defence (it logs handler rejections too), but we
 * also keep ours so the meta is shaped for the audit context.
 */
export function installAuditSubscribers(
  deps: InstallAuditSubscribersDeps
): Unsubscribe[] {
  const { bus, securityEvents, appender, logger } = deps;
  const handles: Unsubscribe[] = [];

  // 1. Domain → security-events fan-out.
  for (const prefix of SECURITY_EVENT_DOMAINS) {
    const handle = bus.subscribe(`${prefix}*`, (evt: DomainEvent<unknown>) => {
      const input = toSecurityEventInput(evt);
      void securityEvents.record(input).catch((err: unknown) => {
        logger.error('audit subscriber: securityEvents.record failed', {
          eventType: evt.type,
          eventId: evt.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    });
    handles.push(handle);
  }

  // 2. audit.request → HashChainAppender.append.
  handles.push(
    bus.subscribe('audit.request', (evt: DomainEvent<unknown>) => {
      const entry = evt.payload as AuditEntryInput;
      void appender.append(entry).catch((err: unknown) => {
        logger.error('audit subscriber: appender.append failed', {
          eventId: evt.id,
          action: entry.action,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    })
  );

  // 3. audit.chain.broken → log only (no recursive append).
  handles.push(
    bus.subscribe(
      'audit.chain.broken',
      (evt: DomainEvent<Record<string, unknown>>) => {
        logger.error('audit.chain.broken (subscriber)', {
          eventId: evt.id,
          ...evt.payload,
        });
      }
    )
  );

  return handles;
}

/**
 * Maps a DomainEvent envelope onto a `SecurityEventInput`. Per ADR-0018
 * the SOC stores everything queryable so we always emit *something* —
 * unmapped types fall back to `DATA_ACCESS` and stash the original
 * `type` under `details.eventType` for forensic queries.
 */
export function toSecurityEventInput(
  evt: DomainEvent<unknown>
): SecurityEventInput {
  const type = mapSecurityEventType(evt.type);
  const payload =
    evt.payload && typeof evt.payload === 'object'
      ? (evt.payload as Record<string, unknown>)
      : {};

  const userId = pickString(payload, 'userId') ?? evt.actor?.id;
  const sessionId = pickString(payload, 'sessionId');
  const ipAddress = pickString(payload, 'ipAddress') ?? 'system';
  const userAgent = pickString(payload, 'userAgent') ?? 'event-bus';

  // Always carry the wire `type` and the event id so downstream queries
  // can reconstruct the original envelope even after the SecurityEvent
  // type is collapsed into the legacy enum.
  const details: Record<string, unknown> = {
    eventType: evt.type,
    eventId: evt.id,
    context: evt.context,
    aggregateType: evt.aggregateType,
    aggregateId: evt.aggregateId,
    ...payload,
  };

  const explicitSeverity = severityFor(evt.type);

  const out: SecurityEventInput = {
    type,
    description: describe(evt.type),
    ipAddress,
    userAgent,
    details,
  };
  if (userId !== undefined) out.userId = userId;
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (explicitSeverity !== undefined) out.severity = explicitSeverity;
  return out;
}

function pickString(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Lookup table: DomainEvent `type` → legacy `SecurityEventType` enum.
 * Anything not listed falls through to `DATA_ACCESS` so the SOC at
 * least has a row keyed on the event id and `details.eventType`.
 */
const TYPE_MAP: Readonly<Record<string, SecurityEventType>> = {
  'iam.login.succeeded': SecurityEventType.LOGIN_SUCCESS,
  'iam.login.failed': SecurityEventType.LOGIN_FAILURE,
  'iam.session.opened': SecurityEventType.LOGIN_SUCCESS,
  'iam.session.closed': SecurityEventType.LOGOUT,
  'iam.session.suspicious': SecurityEventType.SUSPICIOUS_LOGIN,
  'iam.password.changed': SecurityEventType.PASSWORD_CHANGE,
  'iam.password.reset_requested': SecurityEventType.PASSWORD_RESET,
  'iam.password.reset_confirmed': SecurityEventType.PASSWORD_RESET,
  'iam.mfa.enabled': SecurityEventType.MFA_ENABLED,
  'iam.mfa.disabled': SecurityEventType.MFA_DISABLED,
  'iam.mfa.verification_success': SecurityEventType.MFA_VERIFICATION_SUCCESS,
  'iam.mfa.verification_failed': SecurityEventType.MFA_VERIFICATION_FAILURE,
  'iam.account.locked': SecurityEventType.ACCOUNT_LOCKED,
  'iam.account.unlocked': SecurityEventType.ACCOUNT_UNLOCKED,
  'iam.token.revoked': SecurityEventType.TOKEN_REVOKED,
  'iam.permission.escalated': SecurityEventType.PERMISSION_ESCALATION,
  'iam.user.registered': SecurityEventType.CONFIGURATION_CHANGE,
  'iam.user.email_verified': SecurityEventType.CONFIGURATION_CHANGE,
};

function mapSecurityEventType(eventType: string): SecurityEventType {
  return TYPE_MAP[eventType] ?? SecurityEventType.DATA_ACCESS;
}

/**
 * One-line description per event type. Stored on the SecurityEvent row
 * for human-readable SOC queries; the bulk of the data lives in
 * `details`.
 */
function describe(eventType: string): string {
  switch (eventType) {
    case 'iam.login.succeeded':
      return 'User logged in successfully';
    case 'iam.login.failed':
      return 'Login attempt failed';
    case 'iam.session.opened':
      return 'Session opened';
    case 'iam.session.closed':
      return 'Session closed';
    case 'iam.session.suspicious':
      return 'Suspicious session activity detected';
    case 'iam.password.changed':
      return 'Password changed';
    case 'iam.password.reset_requested':
      return 'Password reset requested';
    case 'iam.password.reset_confirmed':
      return 'Password reset completed';
    case 'iam.mfa.enabled':
      return 'MFA enabled';
    case 'iam.mfa.disabled':
      return 'MFA disabled';
    case 'iam.mfa.verification_success':
      return 'MFA verification succeeded';
    case 'iam.mfa.verification_failed':
      return 'MFA verification failed';
    case 'iam.account.locked':
      return 'Account locked';
    case 'iam.account.unlocked':
      return 'Account unlocked';
    case 'iam.token.revoked':
      return 'Token revoked';
    case 'iam.permission.escalated':
      return 'Permission escalated';
    default:
      return eventType;
  }
}

/**
 * Per-event severity overrides that beat the default-severity bucketing
 * inside `SecurityEventService.record`. We only set a severity here when
 * the DomainEvent type carries information the legacy enum does not
 * (e.g. session.suspicious deserves CRITICAL even though we map it to
 * SUSPICIOUS_LOGIN which defaults to HIGH).
 */
function severityFor(eventType: string): SecurityEventSeverity | undefined {
  switch (eventType) {
    case 'iam.session.suspicious':
      return SecurityEventSeverity.CRITICAL;
    default:
      return undefined;
  }
}
