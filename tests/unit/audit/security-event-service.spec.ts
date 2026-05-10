import {
  SecurityEventService,
  defaultSeverityFor,
  type SecurityEventInput,
  type SecurityEventPersistShape,
} from '../../../src/services/audit/security-event.service';
import {
  SecurityEventType,
  SecurityEventSeverity,
} from '../../../src/types/auth.types';
import { CapturingLogger } from './_stubs';

class CapturingStore {
  public readonly created: SecurityEventPersistShape[] = [];
  async create(input: SecurityEventPersistShape): Promise<{ _id: unknown }> {
    this.created.push(input);
    return { _id: `evt-${this.created.length}` };
  }
}

describe('SecurityEventService.record', () => {
  let store: CapturingStore;
  let logger: CapturingLogger;
  let service: SecurityEventService;

  beforeEach(() => {
    store = new CapturingStore();
    logger = new CapturingLogger();
    service = new SecurityEventService({ store, logger });
  });

  it('persists the input shape with resolved=false and a defaulted severity', async () => {
    const input: SecurityEventInput = {
      type: SecurityEventType.LOGIN_FAILURE,
      description: 'three failed attempts in a row',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
      userId: 'u-1',
    };

    await service.record(input);

    expect(store.created).toHaveLength(1);
    const stored = store.created[0]!;
    expect(stored.type).toBe(SecurityEventType.LOGIN_FAILURE);
    expect(stored.description).toBe(input.description);
    expect(stored.ipAddress).toBe(input.ipAddress);
    expect(stored.userAgent).toBe(input.userAgent);
    expect(stored.userId).toBe(input.userId);
    expect(stored.resolved).toBe(false);
    expect(stored.severity).toBe(SecurityEventSeverity.HIGH);
  });

  it('preserves an explicit severity over the default', async () => {
    await service.record({
      type: SecurityEventType.LOGIN_FAILURE,
      description: 'critical-tagged failure',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
      severity: SecurityEventSeverity.CRITICAL,
    });

    expect(store.created[0]?.severity).toBe(SecurityEventSeverity.CRITICAL);
  });

  it('passes details through verbatim when supplied', async () => {
    const details = { fingerprint: 'fp-1', mfaEnrolled: false };
    await service.record({
      type: SecurityEventType.SUSPICIOUS_LOGIN,
      description: 'geo-velocity anomaly detected from new device',
      ipAddress: '203.0.113.5',
      userAgent: 'jest',
      details,
    });
    expect(store.created[0]?.details).toEqual(details);
  });

  it('logs and swallows store errors instead of throwing', async () => {
    const explosive = {
      async create() {
        throw new Error('mongo down');
      },
    };
    const svc = new SecurityEventService({ store: explosive, logger });

    await expect(
      svc.record({
        type: SecurityEventType.LOGIN_SUCCESS,
        description: 'ok',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      })
    ).resolves.toBeUndefined();

    expect(
      logger.events.some(
        e => e.level === 'error' && e.message.includes('failed to persist')
      )
    ).toBe(true);
  });

  describe('defaultSeverityFor (severity bucketing)', () => {
    it('low: success/logout/MFA-success', () => {
      expect(defaultSeverityFor(SecurityEventType.LOGIN_SUCCESS)).toBe(
        SecurityEventSeverity.LOW
      );
      expect(defaultSeverityFor(SecurityEventType.LOGOUT)).toBe(
        SecurityEventSeverity.LOW
      );
      expect(
        defaultSeverityFor(SecurityEventType.MFA_VERIFICATION_SUCCESS)
      ).toBe(SecurityEventSeverity.LOW);
    });

    it('high: failure/anomaly/escalation', () => {
      expect(defaultSeverityFor(SecurityEventType.LOGIN_FAILURE)).toBe(
        SecurityEventSeverity.HIGH
      );
      expect(defaultSeverityFor(SecurityEventType.SUSPICIOUS_LOGIN)).toBe(
        SecurityEventSeverity.HIGH
      );
      expect(defaultSeverityFor(SecurityEventType.PERMISSION_ESCALATION)).toBe(
        SecurityEventSeverity.HIGH
      );
    });

    it('medium: account state mutations', () => {
      expect(defaultSeverityFor(SecurityEventType.ACCOUNT_LOCKED)).toBe(
        SecurityEventSeverity.MEDIUM
      );
      expect(defaultSeverityFor(SecurityEventType.MFA_DISABLED)).toBe(
        SecurityEventSeverity.MEDIUM
      );
      expect(defaultSeverityFor(SecurityEventType.PASSWORD_CHANGE)).toBe(
        SecurityEventSeverity.MEDIUM
      );
    });
  });
});
