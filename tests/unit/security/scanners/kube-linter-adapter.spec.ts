// KubeLinterAdapter — command construction, stdin manifests, JSON parsing.

import {
  KubeLinterAdapter,
  mapKubeLinterSeverity,
} from '../../../../src/contexts/security/infrastructure/scanners/kube-linter-adapter';
import {
  StubSubprocessRunner,
  stubFailure,
  stubJsonResult,
  stubNotFound,
  stubTimeout,
} from '../../../../src/contexts/security/infrastructure/scanners/_subprocess';
import {
  BackpressureError,
  NotConfiguredError,
  ProviderError,
} from '../../../../src/shared/errors';
import { FixedClock } from '../../../../src/shared/kernel';

const sampleReport = {
  Reports: [
    {
      Diagnostic: { Message: 'Pod runs privileged' },
      Check: { Name: 'privileged-container' },
      Object: {
        K8sObject: {
          GroupVersionKind: { Group: '', Version: 'v1', Kind: 'Pod' },
          Namespace: 'demo',
          Name: 'p1',
        },
      },
      Remediation: 'Drop privileged',
    },
    {
      Diagnostic: { Message: 'No probes' },
      Check: { Name: 'no-readiness-probe' },
      Object: {
        K8sObject: {
          GroupVersionKind: {
            Group: 'apps',
            Version: 'v1',
            Kind: 'Deployment',
          },
          Namespace: 'demo',
          Name: 'd1',
        },
      },
    },
  ],
};

function makeInput() {
  return {
    records: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        namespace: 'demo',
        name: 'p1',
        labels: { app: 'demo' },
        annotations: {},
        spec: { containers: [{ name: 'c', image: 'x:1' }] },
        status: {},
      },
    ],
  };
}

describe('KubeLinterAdapter', () => {
  it('mapKubeLinterSeverity', () => {
    expect(mapKubeLinterSeverity('privileged-container')).toBe('critical');
    expect(mapKubeLinterSeverity('host-pid')).toBe('high');
    expect(mapKubeLinterSeverity('no-readiness-probe')).toBe('low');
    expect(mapKubeLinterSeverity('unknown-check')).toBe('medium');
    expect(mapKubeLinterSeverity('foo', { foo: 'critical' as const })).toBe(
      'critical'
    );
  });

  it('toggle off → []', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => false,
      runner,
    });
    expect(await adapter.scan(makeInput())).toEqual([]);
  });

  it('returns [] for empty input even when enabled', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
    });
    expect(await adapter.scan({ records: [] })).toEqual([]);
  });

  it('constructs `kube-linter lint --format json -` and writes manifests to stdin', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => stubJsonResult(sampleReport));
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    await adapter.scan(makeInput());
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.command).toBe('kube-linter');
    expect(call.args).toEqual(['lint', '--format', 'json', '-']);
    expect(call.stdin).toBeDefined();
    expect(call.stdin).toContain('"apiVersion":"v1"');
    expect(call.stdin).toContain('"kind":"Pod"');
  });

  it('parses Reports into RawFindings with proper severity / resource', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => stubJsonResult(sampleReport));
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    const res = await adapter.scan(makeInput());
    expect(res).toHaveLength(2);
    expect(res[0]!.severity).toBe('critical');
    expect(res[0]!.recommendation).toBe('Drop privileged');
    expect(res[0]!.resource.kind).toBe('Pod');
    expect(res[1]!.resource.apiVersion).toBe('apps/v1');
    expect(res[1]!.resource.kind).toBe('Deployment');
  });

  it('treats exit code 1 as findings-present (not an error)', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => ({
      exitCode: 1,
      stdout: JSON.stringify(sampleReport),
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
    });
    const res = await adapter.scan(makeInput());
    expect(res).toHaveLength(2);
  });

  it('exit code > 1 → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => stubFailure(2, 'bad yaml'));
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('not found → NotConfiguredError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => stubNotFound('kube-linter'));
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      NotConfiguredError
    );
  });

  it('timeout → BackpressureError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-linter', () => stubTimeout());
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      BackpressureError
    );
  });
});
