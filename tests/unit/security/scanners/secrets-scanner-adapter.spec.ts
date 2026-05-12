// SecretsScannerAdapter — command construction, JSON parsing, errors.

import {
  SecretsScannerAdapter,
  mapGitleaksSeverity,
} from '../../../../src/contexts/security/infrastructure/scanners/secrets-scanner-adapter';
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

const sampleReport = [
  {
    RuleID: 'aws-access-token',
    Description: 'AWS access key',
    File: 'src/main.ts',
    StartLine: 12,
    EndLine: 12,
    Match: 'REDACTED',
    Entropy: 4.2,
  },
  {
    RuleID: 'jwt',
    Description: 'JWT detected',
    File: 'src/api.ts',
    StartLine: 99,
  },
];

const EMPTY = { records: [] };

describe('SecretsScannerAdapter', () => {
  it('mapGitleaksSeverity', () => {
    expect(mapGitleaksSeverity('aws-access-token')).toBe('critical');
    expect(mapGitleaksSeverity('private-key')).toBe('critical');
    expect(mapGitleaksSeverity('jwt')).toBe('high');
    expect(mapGitleaksSeverity('high-entropy-string')).toBe('medium');
    expect(mapGitleaksSeverity('something-new')).toBe('high');
    expect(mapGitleaksSeverity(undefined)).toBe('high');
  });

  it('toggle off → []', async () => {
    const runner = new StubSubprocessRunner();
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => false,
      runner,
    });
    expect(await adapter.scan(EMPTY)).toEqual([]);
  });

  it('constructs `gitleaks detect ... --redact`', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => stubJsonResult(sampleReport));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
      sourcePath: '/repo',
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    await adapter.scan(EMPTY);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe('gitleaks');
    expect(runner.calls[0]!.args).toEqual([
      'detect',
      '--source',
      '/repo',
      '--report-format',
      'json',
      '--report-path',
      '/dev/stdout',
      '--no-banner',
      '--redact',
    ]);
  });

  it('parses two findings with correct severity', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => stubJsonResult(sampleReport));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
      clock: new FixedClock(new Date('2025-01-01T00:00:00Z')),
    });
    const res = await adapter.scan(EMPTY);
    expect(res).toHaveLength(2);
    expect(res[0]!.severity).toBe('critical');
    expect(res[1]!.severity).toBe('high');
    expect(res[0]!.resource.name).toBe('src/main.ts#L12');
  });

  it('exit code 1 with leaks is OK', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => ({
      exitCode: 1,
      stdout: JSON.stringify(sampleReport),
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    const res = await adapter.scan(EMPTY);
    expect(res).toHaveLength(2);
  });

  it('empty stdout → []', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    expect(await adapter.scan(EMPTY)).toEqual([]);
  });

  it('exit > 1 → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => stubFailure(2, 'config error'));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY)).rejects.toBeInstanceOf(ProviderError);
  });

  it('missing binary → NotConfiguredError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => stubNotFound('gitleaks'));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY)).rejects.toBeInstanceOf(
      NotConfiguredError
    );
  });

  it('timeout → BackpressureError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => stubTimeout());
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY)).rejects.toBeInstanceOf(BackpressureError);
  });

  it('unparseable → ProviderError', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('gitleaks', () => ({
      exitCode: 0,
      stdout: '{not json',
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner,
    });
    await expect(adapter.scan(EMPTY)).rejects.toBeInstanceOf(ProviderError);
  });
});
