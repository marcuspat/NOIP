// TrivyAdapter — command construction, JSON parsing, error mapping.

import {
  TrivyAdapter,
  extractImageTargets,
  mapTrivySeverity,
} from '../../../../src/contexts/security/infrastructure/scanners/trivy-adapter';
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
  Results: [
    {
      Target: 'alpine:3.10 (alpine 3.10.9)',
      Class: 'os-pkgs',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-1',
          PkgName: 'pkg1',
          InstalledVersion: '1.0',
          FixedVersion: '1.1',
          Severity: 'CRITICAL',
          Title: 'Crit issue',
        },
        {
          VulnerabilityID: 'CVE-2',
          PkgName: 'pkg2',
          InstalledVersion: '2.0',
          Severity: 'HIGH',
          Description: 'High issue',
        },
        {
          VulnerabilityID: 'CVE-3',
          PkgName: 'pkg3',
          InstalledVersion: '3.0',
          Severity: 'UNKNOWN',
        },
      ],
    },
  ],
};

function makeInput(image = 'alpine:3.10') {
  return {
    records: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        namespace: 'demo',
        name: 'p1',
        labels: {},
        annotations: {},
        spec: { containers: [{ name: 'c', image }] },
        status: {},
      },
    ],
  };
}

describe('TrivyAdapter', () => {
  it('mapTrivySeverity normalises trivy severity strings', () => {
    expect(mapTrivySeverity('CRITICAL')).toBe('critical');
    expect(mapTrivySeverity('high')).toBe('high');
    expect(mapTrivySeverity('Medium')).toBe('medium');
    expect(mapTrivySeverity('LOW')).toBe('low');
    expect(mapTrivySeverity('UNKNOWN')).toBe('low');
    expect(mapTrivySeverity(undefined)).toBe('low');
  });

  it('extractImageTargets pulls unique image refs from Pod containers', () => {
    const targets = extractImageTargets({
      records: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          namespace: 'a',
          name: 'p1',
          labels: {},
          annotations: {},
          spec: {
            containers: [
              { name: 'c1', image: 'img:1' },
              { name: 'c2', image: 'img:2' },
            ],
            initContainers: [{ name: 'i1', image: 'img:1' }],
          },
          status: {},
        },
        {
          apiVersion: 'v1',
          kind: 'Service',
          namespace: 'a',
          name: 's1',
          labels: {},
          annotations: {},
          spec: {},
          status: {},
        },
      ],
    });
    expect(targets.map(t => t.image).sort()).toEqual(['img:1', 'img:2']);
  });

  it('returns [] when the toggle is off', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new TrivyAdapter({
      realScannersFlag: () => false,
      runner,
    });
    const res = await adapter.scan(makeInput());
    expect(res).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it('constructs the trivy command exactly as documented', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => stubJsonResult(sampleReport));
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    await adapter.scan(makeInput('alpine:3.10'));
    expect(runner.calls).toEqual([
      {
        command: 'trivy',
        args: [
          'image',
          '--format',
          'json',
          '--quiet',
          '--severity',
          'LOW,MEDIUM,HIGH,CRITICAL',
          'alpine:3.10',
        ],
      },
    ]);
  });

  it('maps the JSON report into 3 RawFindings with correct severities', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => stubJsonResult(sampleReport));
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    const res = await adapter.scan(makeInput());
    expect(res).toHaveLength(3);
    expect(res.map(r => r.severity)).toEqual(['critical', 'high', 'low']);
    expect(res[0]!.recommendation).toMatch(/Upgrade pkg1/);
    expect(res[1]!.recommendation).toMatch(/Track CVE-2/);
    expect(res[0]!.evidence.source).toBe('trivy');
  });

  it('non-zero exit → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => stubFailure(2, 'invalid image'));
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('binary not found → NotConfiguredError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => stubNotFound('trivy'));
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      NotConfiguredError
    );
  });

  it('timeout → BackpressureError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => stubTimeout());
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      BackpressureError
    );
  });

  it('unparseable JSON → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('trivy', () => ({
      exitCode: 0,
      stdout: 'not json',
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(makeInput())).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('returns [] when no images are present in the input', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner,
    });
    const res = await adapter.scan({ records: [] });
    expect(res).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });
});
