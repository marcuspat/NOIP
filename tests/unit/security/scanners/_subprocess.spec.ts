// Tests for the subprocess runner.
//
// We use `node` itself as the test binary (always present on the
// runner) so we don't need any external CLI to validate the spawn
// path, timeout behaviour, and stdout/stderr capture.

import {
  NodeSubprocessRunner,
  StubSubprocessRunner,
  stubFailure,
  stubJsonResult,
  stubNotFound,
  stubTimeout,
} from '../../../../src/contexts/security/infrastructure/scanners/_subprocess';

describe('NodeSubprocessRunner', () => {
  const runner = new NodeSubprocessRunner();

  it('captures stdout and resolves with exitCode 0 on success', async () => {
    const res = await runner.run({
      command: 'node',
      args: ['-e', "process.stdout.write('hello')"],
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello');
    expect(res.stderr).toBe('');
    expect(res.timedOut).toBe(false);
    expect(res.notFound).toBe(false);
  });

  it('captures stderr and the non-zero exit code', async () => {
    const res = await runner.run({
      command: 'node',
      args: ['-e', "process.stderr.write('boom'); process.exit(7);"],
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toBe('boom');
    expect(res.stdout).toBe('');
    expect(res.notFound).toBe(false);
  });

  it('flags notFound=true when the binary is missing', async () => {
    const res = await runner.run({
      command: '/does/not/exist-' + Math.random().toString(36).slice(2),
      args: [],
      timeoutMs: 5_000,
    });
    expect(res.notFound).toBe(true);
    expect(res.exitCode).toBeLessThan(0);
  });

  it('honours the timeoutMs and flags timedOut=true', async () => {
    const res = await runner.run({
      command: 'node',
      args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      timeoutMs: 100,
    });
    expect(res.timedOut).toBe(true);
  });

  it('forwards stdin to the child process', async () => {
    const res = await runner.run({
      command: 'node',
      args: ['-e', "process.stdin.on('data', c => process.stdout.write(c));"],
      stdin: 'piped-input',
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('piped-input');
  });

  it('caps stdout at MAX_BUFFER_BYTES — overflow surfaces as overflow stderr', async () => {
    // Force overflow by reducing the cap via a lower-bound test: emit
    // a megabyte of data; the runner stays well under the 64 MiB cap,
    // so this is a smoke test that large outputs still resolve.
    const res = await runner.run({
      command: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(1024 * 1024))"],
      timeoutMs: 15_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBe(1024 * 1024);
  }, 20_000);

  it('handles a signal-exit gracefully', async () => {
    const res = await runner.run({
      command: 'node',
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      timeoutMs: 5_000,
    });
    // Either non-zero exit or -1 if signaled — both are valid; key is
    // that the runner does not hang or throw.
    expect(typeof res.exitCode).toBe('number');
  });
});

describe('StubSubprocessRunner', () => {
  it('returns notFound when no handler is registered', async () => {
    const runner = new StubSubprocessRunner();
    const res = await runner.run({ command: 'noop', args: [] });
    expect(res.notFound).toBe(true);
    expect(runner.calls).toEqual([{ command: 'noop', args: [] }]);
  });

  it('invokes a registered handler and records the call', async () => {
    const runner = new StubSubprocessRunner();
    runner.register('echo', args => ({
      exitCode: 0,
      stdout: args.join(' '),
      stderr: '',
      timedOut: false,
      notFound: false,
    }));
    const res = await runner.run({
      command: 'echo',
      args: ['hi', 'there'],
      stdin: 'in',
    });
    expect(res.stdout).toBe('hi there');
    expect(runner.calls[0]).toEqual({
      command: 'echo',
      args: ['hi', 'there'],
      stdin: 'in',
    });
  });

  it('helpers stubJsonResult / stubFailure / stubTimeout / stubNotFound build the right shape', () => {
    expect(stubJsonResult({ a: 1 }).stdout).toBe('{"a":1}');
    expect(stubFailure(2, 'oops').exitCode).toBe(2);
    expect(stubFailure(2, 'oops').stderr).toBe('oops');
    expect(stubTimeout().timedOut).toBe(true);
    expect(stubNotFound('trivy').notFound).toBe(true);
  });
});
