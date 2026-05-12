// KubeBenchAdapter — command construction, JSON parsing, error mapping.

import {
  KubeBenchAdapter,
  mapKubeBenchSeverity,
} from '../../../../src/contexts/security/infrastructure/scanners/kube-bench-adapter';
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
  Controls: [
    {
      id: '1',
      version: '1.23',
      text: 'Control plane',
      node_type: 'master',
      tests: [
        {
          section: '1.1',
          desc: 'API server',
          results: [
            {
              test_number: '1.1.1',
              test_desc: 'API server should be secure',
              status: 'FAIL',
              scored: true,
              remediation: 'Lock it down',
            },
            {
              test_number: '1.1.2',
              test_desc: 'Recommended audit log',
              status: 'WARN',
              scored: true,
            },
            {
              test_number: '1.1.3',
              test_desc: 'Some check',
              status: 'PASS',
              scored: true,
            },
            {
              test_number: '1.1.4',
              test_desc: 'Not scored fail',
              status: 'FAIL',
              scored: false,
            },
          ],
        },
      ],
    },
  ],
};

const EMPTY_INPUT = { records: [] };

describe('KubeBenchAdapter', () => {
  it('mapKubeBenchSeverity', () => {
    expect(mapKubeBenchSeverity('FAIL', true)).toBe('high');
    expect(mapKubeBenchSeverity('FAIL', false)).toBe('medium');
    expect(mapKubeBenchSeverity('WARN', true)).toBe('low');
    expect(mapKubeBenchSeverity('PASS', true)).toBeNull();
    expect(mapKubeBenchSeverity('INFO', true)).toBeNull();
    expect(mapKubeBenchSeverity('OTHER', true)).toBeNull();
  });

  it('toggle off → []', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => false,
      runner,
    });
    expect(await adapter.scan(EMPTY_INPUT)).toEqual([]);
  });

  it('constructs `kube-bench run --json`', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => stubJsonResult(sampleReport));
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    await adapter.scan(EMPTY_INPUT);
    expect(runner.calls).toEqual([
      { command: 'kube-bench', args: ['run', '--json'] },
    ]);
  });

  it('parses controls/tests/results into RawFindings, dropping PASS/INFO', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => stubJsonResult(sampleReport));
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    const res = await adapter.scan(EMPTY_INPUT);
    expect(res).toHaveLength(3);
    expect(res.map(r => r.severity)).toEqual(['high', 'low', 'medium']);
    expect(res[0]!.resource.kind).toBe('CISControl');
    expect(res[0]!.recommendation).toBe('Lock it down');
  });

  it('cannedReport bypasses subprocess', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
      cannedReport: JSON.stringify(sampleReport),
    });
    const res = await adapter.scan(EMPTY_INPUT);
    expect(res).toHaveLength(3);
    expect(runner.calls).toHaveLength(0);
  });

  it('non-zero exit → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => stubFailure(2, 'no cluster'));
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY_INPUT)).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('missing binary → NotConfiguredError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => stubNotFound('kube-bench'));
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY_INPUT)).rejects.toBeInstanceOf(
      NotConfiguredError
    );
  });

  it('timeout → BackpressureError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => stubTimeout());
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY_INPUT)).rejects.toBeInstanceOf(
      BackpressureError
    );
  });

  it('unparseable JSON → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('kube-bench', () => ({
      exitCode: 0,
      stdout: 'garbage',
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new KubeBenchAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY_INPUT)).rejects.toBeInstanceOf(
      ProviderError
    );
  });
});
