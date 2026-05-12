// Helper: probe whether a CLI binary is available on PATH. Used to
// skip contract tests when the corresponding tool isn't installed.

import { spawn } from 'node:child_process';

export async function isBinaryAvailable(name: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false;
    const child = spawn('which', [name], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(false);
    }, 2_000);
    // Allow the process to exit while a stray timer is still pending.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}

/**
 * Logs `[contract] tool=<name> available=<bool>` once per process for
 * the requested binary. Returns the availability.
 */
export async function announceBinary(name: string): Promise<boolean> {
  const available = await isBinaryAvailable(name);

  console.log(`[contract] tool=${name} available=${available}`);
  return available;
}
