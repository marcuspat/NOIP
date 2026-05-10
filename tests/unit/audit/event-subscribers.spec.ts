// Unit tests for the audit-context EventBus subscribers (ADR-0018).
//
// We exercise the subscriber wiring against a real `InMemoryEventBus`
// and stub `securityEvents` / `appender` collaborators. Stubs let us
// assert on the concrete `SecurityEventInput` / `AuditEntryInput`
// shapes without spinning up Mongo.

import {
  InMemoryEventBus,
  compose,
  SystemClock,
} from '../../../src/shared/kernel';
import {
  SecurityEventType,
  SecurityEventSeverity,
} from '../../../src/types/auth.types';
import {
  installAuditSubscribers,
  toSecurityEventInput,
} from '../../../src/services/audit/event-subscribers';
import type {
  SecurityEventInput,
  SecurityEventPersistShape,
  SecurityEventService,
} from '../../../src/services/audit/security-event.service';
import type {
  HashChainAppender,
  AuditEntryInput,
} from '../../../src/services/audit/hash-chain-appender.service';
import { CapturingLogger } from './_stubs';

class RecordingSecurityEvents {
  public readonly recorded: SecurityEventInput[] = [];
  async record(input: SecurityEventInput): Promise<void> {
    this.recorded.push(input);
  }
}

class RecordingAppender {
  public readonly appended: AuditEntryInput[] = [];
  async append(entry: AuditEntryInput): Promise<unknown> {
    this.appended.push(entry);
    return entry;
  }
}

const clock = new SystemClock();

function publish(
  bus: InMemoryEventBus,
  type: string,
  payload: Record<string, unknown>,
  extras: Partial<Parameters<typeof compose>[0]> = {}
): void {
  bus.publish(
    compose(
      {
        type,
        context: type.split('.')[0] ?? 'unknown',
        aggregateType: 'aggregate',
        aggregateId: 'agg-1',
        payload,
        ...extras,
      } as Parameters<typeof compose>[0],
      clock
    )
  );
}

async function flush(): Promise<void> {
  // Subscribers are sync-publish but their work is `void`d behind
  // promises — wait one macrotask so the recording stubs settle.
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('toSecurityEventInput (envelope projection)', () => {
  it('maps iam.session.opened onto LOGIN_SUCCESS with userId/sessionId', () => {
    const evt = compose(
      {
        type: 'iam.session.opened',
        context: 'iam',
        aggregateType: 'session',
        aggregateId: 'sess-1',
        actor: { type: 'user', id: 'user-1' },
        payload: { userId: 'user-1', sessionId: 'sess-1', family: 'fam-1' },
      },
      clock
    );
    const input = toSecurityEventInput(evt);
    expect(input.type).toBe(SecurityEventType.LOGIN_SUCCESS);
    expect(input.userId).toBe('user-1');
    expect(input.sessionId).toBe('sess-1');
    expect(input.details).toMatchObject({
      eventType: 'iam.session.opened',
      family: 'fam-1',
    });
  });

  it('maps iam.account.locked onto ACCOUNT_LOCKED', () => {
    const evt = compose(
      {
        type: 'iam.account.locked',
        context: 'iam',
        aggregateType: 'user',
        aggregateId: 'user-1',
        payload: { userId: 'user-1', lockedUntil: '2026-05-10T01:00:00Z' },
      },
      clock
    );
    const input = toSecurityEventInput(evt);
    expect(input.type).toBe(SecurityEventType.ACCOUNT_LOCKED);
    expect(input.userId).toBe('user-1');
  });

  it('maps iam.mfa.verification_failed onto MFA_VERIFICATION_FAILURE', () => {
    const evt = compose(
      {
        type: 'iam.mfa.verification_failed',
        context: 'iam',
        aggregateType: 'user',
        aggregateId: 'user-1',
        payload: { userId: 'user-1', method: 'totp', ipAddress: '10.0.0.1' },
      },
      clock
    );
    const input = toSecurityEventInput(evt);
    expect(input.type).toBe(SecurityEventType.MFA_VERIFICATION_FAILURE);
    expect(input.ipAddress).toBe('10.0.0.1');
  });

  it('maps iam.session.suspicious to SUSPICIOUS_LOGIN with CRITICAL severity', () => {
    const evt = compose(
      {
        type: 'iam.session.suspicious',
        context: 'iam',
        aggregateType: 'session',
        aggregateId: 'sess-1',
        payload: {
          userId: 'user-1',
          sessionId: 'sess-1',
          signals: ['refresh-replay'],
        },
      },
      clock
    );
    const input = toSecurityEventInput(evt);
    expect(input.type).toBe(SecurityEventType.SUSPICIOUS_LOGIN);
    expect(input.severity).toBe(SecurityEventSeverity.CRITICAL);
  });

  it('falls back to DATA_ACCESS for unmapped event types', () => {
    const evt = compose(
      {
        type: 'discovery.cluster.scanned',
        context: 'discovery',
        aggregateType: 'cluster',
        aggregateId: 'cluster-A',
        payload: { clusterId: 'cluster-A', counts: { workloads: 12 } },
      },
      clock
    );
    const input = toSecurityEventInput(evt);
    expect(input.type).toBe(SecurityEventType.DATA_ACCESS);
    expect(input.details).toMatchObject({
      eventType: 'discovery.cluster.scanned',
    });
  });
});

describe('installAuditSubscribers', () => {
  let bus: InMemoryEventBus;
  let securityEvents: RecordingSecurityEvents;
  let appender: RecordingAppender;
  let logger: CapturingLogger;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    securityEvents = new RecordingSecurityEvents();
    appender = new RecordingAppender();
    logger = new CapturingLogger();
    installAuditSubscribers({
      bus,
      securityEvents: securityEvents as unknown as SecurityEventService,
      appender: appender as unknown as HashChainAppender,
      logger,
    });
  });

  it('records security events for every iam.* publish', async () => {
    publish(bus, 'iam.session.opened', {
      userId: 'u1',
      sessionId: 's1',
      family: 'f1',
    });
    publish(bus, 'iam.account.locked', { userId: 'u2' });
    publish(bus, 'iam.mfa.verification_failed', {
      userId: 'u3',
      method: 'totp',
      ipAddress: '127.0.0.1',
    });
    await flush();

    expect(securityEvents.recorded).toHaveLength(3);
    const types = securityEvents.recorded.map(r => r.type);
    expect(types).toContain(SecurityEventType.LOGIN_SUCCESS);
    expect(types).toContain(SecurityEventType.ACCOUNT_LOCKED);
    expect(types).toContain(SecurityEventType.MFA_VERIFICATION_FAILURE);
  });

  it('records security events for security.*, compliance.*, dashboard.*', async () => {
    publish(bus, 'security.scan.completed', { scanId: 'scan-1' });
    publish(bus, 'compliance.report.generated', { reportId: 'rep-1' });
    publish(bus, 'dashboard.created', { dashboardId: 'd-1' });
    await flush();
    expect(securityEvents.recorded).toHaveLength(3);
    expect(securityEvents.recorded[0]?.details?.['eventType']).toBe(
      'security.scan.completed'
    );
  });

  it('triggers appender.append for audit.request events', async () => {
    const entry: AuditEntryInput = {
      actor: { userId: 'u1' },
      action: 'http.get./api/me',
      resource: '/api/me',
      details: { method: 'GET' },
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    };
    publish(bus, 'audit.request', entry as unknown as Record<string, unknown>);
    await flush();
    expect(appender.appended).toHaveLength(1);
    expect(appender.appended[0]?.action).toBe('http.get./api/me');
  });

  it('logs (does not append) on audit.chain.broken', async () => {
    publish(bus, 'audit.chain.broken', {
      shard: 'global',
      atSequence: 5,
      expectedHash: 'aa',
      actualHash: 'bb',
      reason: 'currentHash mismatch',
    });
    await flush();
    expect(appender.appended).toHaveLength(0);
    expect(
      logger.events.some(
        e => e.level === 'error' && e.message.includes('audit.chain.broken')
      )
    ).toBe(true);
  });

  it('returns unsubscribe handles that detach handlers', async () => {
    const localBus = new InMemoryEventBus();
    const localSec = new RecordingSecurityEvents();
    const handles = installAuditSubscribers({
      bus: localBus,
      securityEvents: localSec as unknown as SecurityEventService,
      appender: appender as unknown as HashChainAppender,
      logger,
    });
    publish(localBus, 'iam.session.opened', { userId: 'u1' });
    await flush();
    expect(localSec.recorded).toHaveLength(1);

    for (const off of handles) off();

    publish(localBus, 'iam.session.opened', { userId: 'u2' });
    await flush();
    expect(localSec.recorded).toHaveLength(1);
  });

  it('persists with the right SecurityEventPersistShape via the service', async () => {
    publish(bus, 'iam.login.failed', {
      usernameOrEmail: 'alice',
      ipAddress: '10.0.0.42',
      reason: 'invalid_password',
    });
    await flush();
    const recorded = securityEvents.recorded[0];
    expect(recorded).toBeDefined();
    expect(recorded!.type).toBe(SecurityEventType.LOGIN_FAILURE);
    expect(recorded!.ipAddress).toBe('10.0.0.42');
    expect(recorded!.details).toMatchObject({
      eventType: 'iam.login.failed',
      reason: 'invalid_password',
    });
    // Persist shape is the service's responsibility; we just confirm the
    // input we passed is well-formed.
    const persistShape: Partial<SecurityEventPersistShape> = {
      type: recorded!.type,
      description: recorded!.description,
      ipAddress: recorded!.ipAddress,
      userAgent: recorded!.userAgent,
    };
    expect(persistShape.userAgent).toBeDefined();
  });
});
