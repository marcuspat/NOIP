// Subprocess runner used by the real CLI scanner adapters.
//
// The Node implementation wraps `child_process.spawn` with:
//   - bounded stdout/stderr buffering (caps at `MAX_BUFFER_BYTES`),
//   - AbortController-driven timeout,
//   - clean signal propagation (SIGTERM then SIGKILL).
//
// Tests use the `StubSubprocessRunner` to assert command construction
// and output parsing without touching real CLIs.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** Maximum bytes we will buffer for stdout/stderr combined per stream. 64 MiB. */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface SubprocessRunOpts {
  command: string;
  args: ReadonlyArray<string>;
  stdin?: string;
  /** Hard wall-clock timeout in ms. Default 60_000. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the OS reported the command was not found (ENOENT). */
  notFound: boolean;
}

export interface SubprocessRunner {
  run(opts: SubprocessRunOpts): Promise<SubprocessResult>;
}

/**
 * Production subprocess runner. Uses node:child_process.spawn so we
 * never go through a shell — args are passed verbatim, so adapter
 * authors don't need to worry about quoting or injection.
 */
export class NodeSubprocessRunner implements SubprocessRunner {
  async run(opts: SubprocessRunOpts): Promise<SubprocessResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<SubprocessResult>(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(opts.command, [...opts.args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          resolve({
            exitCode: -1,
            stdout: '',
            stderr: e.message,
            timedOut: false,
            notFound: true,
          });
          return;
        }
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: e.message,
          timedOut: false,
          notFound: false,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let overflowed = false;
      let timedOut = false;
      let notFound = false;
      let settled = false;

      const settle = (result: SubprocessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardKillTimer);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutSize += chunk.length;
        if (stdoutSize > MAX_BUFFER_BYTES) {
          overflowed = true;
          child.kill('SIGKILL');
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize > MAX_BUFFER_BYTES) {
          overflowed = true;
          child.kill('SIGKILL');
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          notFound = true;
        }
        settle({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr:
            Buffer.concat(stderrChunks).toString('utf8') ||
            err.message ||
            String(err),
          timedOut,
          notFound,
        });
      });

      child.on('close', (code, signal) => {
        // Signal info is encoded in (exitCode==-1, timedOut). We do not
        // propagate `signal` directly beyond this scope.
        void signal;
        if (overflowed) {
          settle({
            exitCode: code ?? -1,
            stdout: '',
            stderr: 'output exceeded MAX_BUFFER_BYTES',
            timedOut,
            notFound,
          });
          return;
        }
        settle({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          notFound,
        });
      });

      // Timeout: send SIGTERM first, then SIGKILL after a grace period.
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      const hardKillTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, timeoutMs + 2_000);

      if (opts.stdin !== undefined && child.stdin) {
        try {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        } catch {
          // If the child died before we could write, the 'error' /
          // 'close' handlers will resolve normally.
        }
      } else if (child.stdin) {
        child.stdin.end();
      }
    });
  }
}

/**
 * Deterministic in-memory runner. Each registered handler is keyed on
 * the command name (the first arg of `run({ command, args })`); the
 * handler receives `(args, stdin)` and returns the result synchronously.
 */
export class StubSubprocessRunner implements SubprocessRunner {
  private readonly handlers: Map<
    string,
    (args: ReadonlyArray<string>, stdin?: string) => SubprocessResult
  >;
  /** Recorded calls for assertions. */
  public readonly calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    stdin?: string;
  }> = [];

  constructor(
    handlers: Map<
      string,
      (args: ReadonlyArray<string>, stdin?: string) => SubprocessResult
    > = new Map()
  ) {
    this.handlers = handlers;
  }

  register(
    command: string,
    handler: (args: ReadonlyArray<string>, stdin?: string) => SubprocessResult
  ): void {
    this.handlers.set(command, handler);
  }

  async run(opts: SubprocessRunOpts): Promise<SubprocessResult> {
    const recorded: {
      command: string;
      args: ReadonlyArray<string>;
      stdin?: string;
    } = { command: opts.command, args: [...opts.args] };
    if (opts.stdin !== undefined) recorded.stdin = opts.stdin;
    this.calls.push(recorded);
    const handler = this.handlers.get(opts.command);
    if (!handler) {
      // No handler registered — simulate "command not found" by default
      // so adapters cleanly translate to NotConfiguredError.
      return {
        exitCode: -1,
        stdout: '',
        stderr: `stub: command not registered: ${opts.command}`,
        timedOut: false,
        notFound: true,
      };
    }
    return handler(opts.args, opts.stdin);
  }
}

/**
 * Convenience: build a successful result with a JSON stdout payload.
 */
export function stubJsonResult(payload: unknown): SubprocessResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(payload),
    stderr: '',
    timedOut: false,
    notFound: false,
  };
}

/** Convenience: a not-found result (ENOENT-equivalent). */
export function stubNotFound(command: string): SubprocessResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr: `${command}: command not found`,
    timedOut: false,
    notFound: true,
  };
}

/** Convenience: a non-zero-exit result with stderr. */
export function stubFailure(
  exitCode: number,
  stderr: string,
  stdout = ''
): SubprocessResult {
  return {
    exitCode,
    stdout,
    stderr,
    timedOut: false,
    notFound: false,
  };
}

/** Convenience: a timeout result. */
export function stubTimeout(): SubprocessResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr: '',
    timedOut: true,
    notFound: false,
  };
}
