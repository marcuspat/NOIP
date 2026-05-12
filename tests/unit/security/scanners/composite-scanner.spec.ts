// CompositeScanner — toggle matrix, concurrency, dedupe, partial events.

import { CompositeScanner } from '../../../../src/contexts/security/infrastructure/scanners/composite-scanner';
import type {
  RawFinding,
  ScannerClient,
  ScannerInput,
} from '../../../../src/contexts/security/domain/ports/scanner-client';
import {
  InMemoryEventBus,
  FixedClock,
  type ClusterId,
  type DomainEvent,
} from '../../../../src/shared/kernel';
import { createCompositeScannerWithRealAdapters } from '../../../../src/contexts/security/api';
import { StubSubprocessRunner } from '../../../../src/contexts/security/infrastructure/scanners/_subprocess';
import { builtinPolicyId } from '../../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';

const EMPTY_INPUT: ScannerInput = { records: [] };

function rawFinding(checkId: string, name: string): RawFinding {
  return {
    policyId: builtinPolicyId(checkId),
    resource: {
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: 'demo',
      name,
    },
    severity: 'high',
    description: 'desc',
    evidence: {
      source: 'test',
      summary: 'summary',
      capturedAt: '2025-01-01T00:00:00Z' as never,
    },
  };
}

class FakeScanner implements ScannerClient {
  constructor(
    public readonly id: string,
    private readonly findings: RawFinding[] | Error,
    private readonly delayMs = 0
  ) {}
  async scan(): Promise<RawFinding[]> {
    if (this.delayMs > 0) {
      await new Promise(r => setTimeout(r, this.delayMs));
    }
    if (this.findings instanceof Error) throw this.findings;
    return this.findings;
  }
}

describe('CompositeScanner', () => {
  it('returns merged RawFindings from all scanners', async () => {
    const composite = new CompositeScanner([
      new FakeScanner('a', [rawFinding('c1', 'p1')]),
      new FakeScanner('b', [rawFinding('c2', 'p2')]),
    ]);
    const res = await composite.scan(EMPTY_INPUT);
    expect(res).toHaveLength(2);
  });

  it('dedupes by (policyId, kind, namespace, name)', async () => {
    const f = rawFinding('cx', 'p1');
    const composite = new CompositeScanner([
      new FakeScanner('a', [f]),
      new FakeScanner('b', [f]),
    ]);
    const res = await composite.scan(EMPTY_INPUT);
    expect(res).toHaveLength(1);
  });

  it('tolerates per-adapter failure', async () => {
    const composite = new CompositeScanner([
      new FakeScanner('a', new Error('boom')),
      new FakeScanner('b', [rawFinding('cx', 'p1')]),
    ]);
    const res = await composite.scan(EMPTY_INPUT);
    expect(res).toHaveLength(1);
  });

  it('honours concurrency cap (no more than N in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    class Counted implements ScannerClient {
      constructor(public readonly id: string) {}
      async scan(): Promise<RawFinding[]> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
        return [];
      }
    }
    const scanners = Array.from({ length: 8 }, (_, i) => new Counted('s' + i));
    const composite = new CompositeScanner(
      scanners,
      { warn: () => undefined },
      {
        concurrency: 3,
      }
    );
    await composite.scan(EMPTY_INPUT);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('emits `security.scan.partial` exactly once on failure', async () => {
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const events: DomainEvent[] = [];
    bus.subscribe('security.scan.partial', evt => {
      events.push(evt);
    });
    const composite = new CompositeScanner(
      [
        new FakeScanner('a', new Error('one')),
        new FakeScanner('b', new Error('two')),
        new FakeScanner('c', []),
      ],
      { warn: () => undefined },
      {
        bus,
        clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
        clusterId: 'c-1' as ClusterId,
      }
    );
    await composite.scan(EMPTY_INPUT);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as {
      failures: Array<{ adapter: string }>;
      succeeded: string[];
      attempted: number;
    };
    expect(payload.failures.map(f => f.adapter).sort()).toEqual(['a', 'b']);
    expect(payload.succeeded).toEqual(['c']);
    expect(payload.attempted).toBe(3);
  });

  it('does NOT emit partial when all scanners succeed', async () => {
    const bus = new InMemoryEventBus({
      warn: () => undefined,
      error: () => undefined,
    });
    const seen: DomainEvent[] = [];
    bus.subscribe('security.scan.partial', e => seen.push(e));
    const composite = new CompositeScanner(
      [new FakeScanner('a', []), new FakeScanner('b', [])],
      { warn: () => undefined },
      {
        bus,
        clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
      }
    );
    await composite.scan(EMPTY_INPUT);
    expect(seen).toHaveLength(0);
  });
});

describe('createCompositeScannerWithRealAdapters', () => {
  it('includes only the builtin when master switch is off', () => {
    const composite = createCompositeScannerWithRealAdapters({
      env: { SECURITY_REAL_SCANNERS: 'false' },
    });
    // CompositeScanner has scanners as private; we can introspect via
    // a scan() with empty input and count the runner calls — but the
    // builtin is the only one that doesn't need a runner, so the easiest
    // assertion is: `enabled` flags translate to scanner array length.
    expect(composite).toBeInstanceOf(CompositeScanner);
    const internal = composite as unknown as {
      scanners: ReadonlyArray<ScannerClient>;
    };
    expect(internal.scanners.map(s => s.id)).toEqual([
      'builtin-policy-scanner',
    ]);
  });

  it('master switch on enables all 5 adapters', () => {
    const composite = createCompositeScannerWithRealAdapters({
      env: { SECURITY_REAL_SCANNERS: 'true' },
    });
    const internal = composite as unknown as {
      scanners: ReadonlyArray<ScannerClient>;
    };
    expect(internal.scanners.map(s => s.id).sort()).toEqual([
      'builtin-policy-scanner',
      'kube-bench',
      'kube-linter',
      'secrets-scanner',
      'trivy',
      'vuln-feed',
    ]);
  });

  it('per-tool opt-out: SECURITY_REAL_TRIVY=false disables Trivy only', () => {
    const composite = createCompositeScannerWithRealAdapters({
      env: {
        SECURITY_REAL_SCANNERS: 'true',
        SECURITY_REAL_TRIVY: 'false',
        SECURITY_REAL_VULN_FEED: 'false',
      },
    });
    const internal = composite as unknown as {
      scanners: ReadonlyArray<ScannerClient>;
    };
    const ids = internal.scanners.map(s => s.id).sort();
    expect(ids).toContain('builtin-policy-scanner');
    expect(ids).toContain('kube-bench');
    expect(ids).not.toContain('trivy');
    expect(ids).not.toContain('vuln-feed');
  });

  it('opts.enabled overrides env toggles', () => {
    const composite = createCompositeScannerWithRealAdapters({
      env: { SECURITY_REAL_SCANNERS: 'false' },
      enabled: { trivy: true },
      runner: new StubSubprocessRunner(),
    });
    const internal = composite as unknown as {
      scanners: ReadonlyArray<ScannerClient>;
    };
    expect(internal.scanners.map(s => s.id)).toContain('trivy');
  });

  it('builtin can be force-disabled via opts.enabled.builtin=false', () => {
    const composite = createCompositeScannerWithRealAdapters({
      env: { SECURITY_REAL_SCANNERS: 'false' },
      enabled: { builtin: false },
    });
    const internal = composite as unknown as {
      scanners: ReadonlyArray<ScannerClient>;
    };
    expect(internal.scanners.map(s => s.id)).toEqual([]);
  });
});
