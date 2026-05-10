// PythonRagBridge — invokes `scripts/update_rag.py` via subprocess.
//
// Phase-4 scope: surface the language boundary as a typed
// `IngestionBridge`. Tests mock the bridge; we do NOT actually run
// Python in the unit-test path. Errors from Python become typed
// `ProviderError`s — Python tracebacks never leak to domain code.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { ProviderError } from '../../../../shared/errors';
import type {
  IngestionBridge,
  IngestionRunSummary,
  IngestionTriggerSpec,
} from '../../domain/ports/ingestion-bridge';

export interface PythonRagBridgeOptions {
  /** Absolute (or repo-relative) path to update_rag.py. */
  scriptPath?: string;
  /** Path to the python interpreter. Default: `python3`. */
  pythonBin?: string;
  /** Subprocess timeout in milliseconds. Default 5 minutes. */
  timeoutMs?: number;
  /**
   * Optional spawn override; tests use this to inject a mock that
   * never actually fires the binary.
   */
  spawnImpl?: (cmd: string, args: string[]) => ChildProcess;
  logger?: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
  };
}

export class PythonRagBridge implements IngestionBridge {
  private readonly scriptPath: string;
  private readonly pythonBin: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: (cmd: string, args: string[]) => ChildProcess;
  private readonly logger: NonNullable<PythonRagBridgeOptions['logger']>;

  constructor(opts: PythonRagBridgeOptions = {}) {
    this.scriptPath = resolve(
      opts.scriptPath ?? resolve(process.cwd(), 'scripts/update_rag.py')
    );
    this.pythonBin = opts.pythonBin ?? 'python3';
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    this.spawnImpl =
      opts.spawnImpl ??
      ((cmd: string, args: string[]) =>
        spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as ChildProcess);
    this.logger = opts.logger ?? {
      info: () => undefined,
      warn: () => undefined,
    };
  }

  async triggerIngestion(
    spec: IngestionTriggerSpec
  ): Promise<IngestionRunSummary> {
    const args: string[] = [this.scriptPath];
    if (spec.since) args.push('--since', spec.since);
    if (spec.collection) args.push('--collection', spec.collection);
    const start = Date.now();
    return new Promise<IngestionRunSummary>((resolveP, rejectP) => {
      const proc = this.spawnImpl(this.pythonBin, args);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        rejectP(new ProviderError('Python ingestion timed out'));
      }, this.timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        rejectP(new ProviderError(err.message));
      });
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const success = code === 0;
        if (!success) {
          this.logger.warn('python rag bridge non-zero exit', {
            code,
            stderr: stderr.slice(0, 200),
          });
          rejectP(
            new ProviderError(
              `update_rag.py exited with code ${code === null ? 'null' : code}`
            )
          );
          return;
        }
        const documents = readDocCount(stdout);
        const message = stdout.split('\n').filter(Boolean).pop();
        const summary: IngestionRunSummary = {
          success: true,
          documents,
          durationMs,
          ...(message !== undefined ? { message } : {}),
        };
        resolveP(summary);
      });
    });
  }
}

function readDocCount(stdout: string): number {
  // Look for a JSON tail line like `{"documents": 12, ...}` first.
  const tail = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .pop();
  if (tail && tail.startsWith('{')) {
    try {
      const parsed = JSON.parse(tail) as Record<string, unknown>;
      if (typeof parsed['documents'] === 'number') return parsed['documents'];
      if (typeof parsed['count'] === 'number') return parsed['count'];
    } catch {
      // fall through
    }
  }
  return 0;
}
