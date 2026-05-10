import {
  FixedClock,
  InMemoryEventBus,
  type DomainEvent,
} from '../../../src/shared/kernel';
import {
  HashChainAppender,
  computeEntryHash,
  canonicalJson,
  DEFAULT_SHARD,
  type AuditEntryInput,
} from '../../../src/services/audit/hash-chain-appender.service';
import { InMemoryAuditCollection, CapturingLogger } from './_stubs';

const baseEntry = (
  overrides: Partial<AuditEntryInput> = {}
): AuditEntryInput => ({
  actor: { userId: 'user-1' },
  action: 'iam.user.create',
  resource: '/api/users',
  resourceId: 'user-1',
  details: { method: 'POST', statusCode: 201 },
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
  ...overrides,
});

describe('HashChainAppender', () => {
  let collection: InMemoryAuditCollection;
  let logger: CapturingLogger;
  let appender: HashChainAppender;
  let clock: FixedClock;

  beforeEach(() => {
    collection = new InMemoryAuditCollection();
    logger = new CapturingLogger();
    clock = new FixedClock(new Date('2026-05-10T00:00:00Z'));
    appender = new HashChainAppender({ collection, clock, logger });
  });

  it('writes a genesis entry with previousHash = 64 zeros at sequence 0', async () => {
    const entry = await appender.append(baseEntry());

    expect(entry.chain.shard).toBe(DEFAULT_SHARD);
    expect(entry.chain.sequence).toBe(0);
    expect(entry.chain.previousHash).toBe('0'.repeat(64));
    expect(entry.chain.currentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(collection.entries).toHaveLength(1);
  });

  it('chains sequential entries with previousHash = previous currentHash', async () => {
    const a = await appender.append(baseEntry({ action: 'a' }));
    const b = await appender.append(baseEntry({ action: 'b' }));
    const c = await appender.append(baseEntry({ action: 'c' }));

    expect(b.chain.previousHash).toBe(a.chain.currentHash);
    expect(c.chain.previousHash).toBe(b.chain.currentHash);
    expect([a.chain.sequence, b.chain.sequence, c.chain.sequence]).toEqual([
      0, 1, 2,
    ]);
  });

  it('verifyRange returns ok=true and checked=N when 100 entries are intact', async () => {
    for (let i = 0; i < 100; i++) {
      // Advance the clock between entries so timestamps differ; this also
      // exercises canonicalisation of Date values.
      clock.advance(1);
      await appender.append(baseEntry({ action: `iam.action.${i}` }));
    }

    const report = await appender.verifyRange(DEFAULT_SHARD, 0, 99);

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(100);
    expect(report.brokenAtSequence).toBeUndefined();
  });

  it('verifyRange detects an injected mutation and emits audit.chain.broken', async () => {
    for (let i = 0; i < 5; i++) {
      await appender.append(baseEntry({ action: `iam.action.${i}` }));
    }

    // Tamper with entry at sequence 2: change the action AFTER the chain
    // hash was computed. Verification must detect this.
    collection.mutateAt(2, e => {
      (e as { action: string }).action = 'iam.action.tampered';
    });

    const report = await appender.verifyRange(DEFAULT_SHARD, 0, 4);

    expect(report.ok).toBe(false);
    expect(report.brokenAtSequence).toBe(2);
    expect(
      logger.events.some(
        e => e.level === 'error' && e.message === 'audit.chain.broken'
      )
    ).toBe(true);
  });

  it('publishes audit.chain.broken on the EventBus when a bus is wired', async () => {
    class RecordingBus extends InMemoryEventBus {
      public readonly events: Array<DomainEvent<unknown>> = [];
      override publish<T>(event: DomainEvent<T>): void {
        this.events.push(event as DomainEvent<unknown>);
        super.publish(event);
      }
    }
    const bus = new RecordingBus();
    const localCollection = new InMemoryAuditCollection();
    const localLogger = new CapturingLogger();
    const localClock = new FixedClock(new Date('2026-05-10T00:00:00Z'));
    const localAppender = new HashChainAppender({
      collection: localCollection,
      clock: localClock,
      logger: localLogger,
      eventBus: bus,
    });
    for (let i = 0; i < 3; i++) {
      await localAppender.append(baseEntry({ action: `a-${i}` }));
    }
    localCollection.mutateAt(1, e => {
      (e as { action: string }).action = 'tampered';
    });
    await localAppender.verifyRange(DEFAULT_SHARD, 0, 2);

    const broken = bus.events.filter(e => e.type === 'audit.chain.broken');
    expect(broken.length).toBeGreaterThanOrEqual(1);
    const payload = broken[0]?.payload as {
      shard: string;
      atSequence: number;
      reason: string;
    };
    expect(payload.shard).toBe(DEFAULT_SHARD);
    expect(payload.atSequence).toBe(1);
    // Logger error line is preserved as redundancy.
    expect(
      localLogger.events.some(
        e => e.level === 'error' && e.message === 'audit.chain.broken'
      )
    ).toBe(true);
  });

  it('verifyRange detects a previousHash splice', async () => {
    await appender.append(baseEntry({ action: 'a' }));
    await appender.append(baseEntry({ action: 'b' }));
    await appender.append(baseEntry({ action: 'c' }));

    collection.mutateAt(1, e => {
      e.chain.previousHash = 'f'.repeat(64);
    });

    const report = await appender.verifyRange(DEFAULT_SHARD, 0, 2);

    expect(report.ok).toBe(false);
    expect(report.brokenAtSequence).toBe(1);
  });

  it('serialises concurrent appends to the same shard (stable sequences)', async () => {
    const N = 50;
    const inputs: AuditEntryInput[] = Array.from({ length: N }, (_, i) =>
      baseEntry({ action: `parallel.${i}`, details: { i } })
    );

    const results = await Promise.all(inputs.map(i => appender.append(i)));

    const sequences = results.map(r => r.chain.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i));

    // Every entry's previousHash must match its predecessor's currentHash
    // when stored in chain order.
    const sortedEntries = [...collection.entries].sort(
      (a, b) => a.chain.sequence - b.chain.sequence
    );
    for (let i = 1; i < sortedEntries.length; i++) {
      expect(sortedEntries[i]!.chain.previousHash).toBe(
        sortedEntries[i - 1]!.chain.currentHash
      );
    }

    const report = await appender.verifyRange(DEFAULT_SHARD, 0, N - 1);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(N);
  });

  it('isolates shards: separate sequences and chains', async () => {
    const a1 = await appender.append(baseEntry({ shard: 'a' }));
    const b1 = await appender.append(baseEntry({ shard: 'b' }));
    const a2 = await appender.append(baseEntry({ shard: 'a' }));

    expect(a1.chain.shard).toBe('a');
    expect(b1.chain.shard).toBe('b');
    expect(a1.chain.sequence).toBe(0);
    expect(b1.chain.sequence).toBe(0);
    expect(a2.chain.sequence).toBe(1);
    expect(a2.chain.previousHash).toBe(a1.chain.currentHash);
  });

  describe('canonicalJson / computeEntryHash', () => {
    it('canonicalJson sorts keys recursively and is deterministic', () => {
      const a = canonicalJson({ b: 1, a: { z: 1, y: 2 }, c: [3, 1, 2] });
      const b = canonicalJson({ a: { y: 2, z: 1 }, c: [3, 1, 2], b: 1 });
      expect(a).toBe(b);
      expect(a).toBe('{"a":{"y":2,"z":1},"b":1,"c":[3,1,2]}');
    });

    it('computeEntryHash returns identical 64-hex digests for identical inputs', () => {
      const fixed = new Date('2026-01-01T00:00:00Z');
      const e1 = {
        actor: { userId: 'u1' },
        action: 'a',
        resource: 'r',
        details: { x: 1 },
        ipAddress: '1.2.3.4',
        userAgent: 'ua',
        timestamp: fixed,
      };
      const h1 = computeEntryHash(e1, '0'.repeat(64));
      const h2 = computeEntryHash(e1, '0'.repeat(64));
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
