// Local-filesystem implementation of `AuditArchiveStore`.
//
// Used by the unit-test harness and by developers who don't want to
// stand up an S3 bucket. The on-disk layout mirrors the S3 key so a
// later migration is a pure copy: `<root>/<key>` for the gzipped
// payload plus `<root>/<key>.sha256` for the integrity sidecar.
//
// Mirrors `LocalFsSnapshotArchiveAdapter` from the discovery context.
// We accept `Uint8Array` (not `Buffer`) so the domain surface stays
// node-agnostic.

import { promises as fs } from 'fs';
import * as path from 'path';
import { ProviderError } from '../../../../shared/errors';
import type {
  AuditArchiveStore,
  AuditArchiveUploadOpts,
  AuditArchiveUploadResult,
} from '../../domain/ports/archive-store';

export interface LocalFsAuditArchiveStoreOpts {
  /** Root directory; created on first write. Defaults to `./.noip-audit-archive`. */
  root?: string;
}

export class LocalFsAuditArchiveStore implements AuditArchiveStore {
  private readonly root: string;

  constructor(opts: LocalFsAuditArchiveStoreOpts = {}) {
    this.root = opts.root ?? path.resolve(process.cwd(), '.noip-audit-archive');
  }

  async upload(
    key: string,
    body: Uint8Array,
    opts: AuditArchiveUploadOpts = {}
  ): Promise<AuditArchiveUploadResult> {
    this.assertSafeKey(key);
    const target = path.join(this.root, key);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      if (opts.checksum) {
        await fs.writeFile(`${target}.sha256`, `${opts.checksum}\n`, 'utf8');
      }
    } catch (err) {
      throw new ProviderError(
        `local-fs audit archive upload failed for ${key}`,
        this.detail(err)
      );
    }
    return { uri: `file://${target}`, size: body.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    this.assertSafeKey(key);
    try {
      await fs.access(path.join(this.root, key));
      return true;
    } catch {
      return false;
    }
  }

  async download(key: string): Promise<Uint8Array> {
    this.assertSafeKey(key);
    try {
      const buf = await fs.readFile(path.join(this.root, key));
      return new Uint8Array(buf);
    } catch (err) {
      throw new ProviderError(
        `local-fs audit archive download failed for ${key}`,
        this.detail(err)
      );
    }
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    this.assertSafeKey(prefix);
    const startDir = path.join(this.root, prefix);
    const out: string[] = [];
    const stack: string[] = [startDir];
    while (stack.length > 0 && out.length < limit) {
      const dir = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile() && !ent.name.endsWith('.sha256')) {
          out.push(path.relative(this.root, full));
          if (out.length >= limit) break;
        }
      }
    }
    return out.sort();
  }

  private assertSafeKey(key: string): void {
    if (key.includes('..') || path.isAbsolute(key)) {
      throw new ProviderError('archive key escapes archive root', { key });
    }
  }

  private detail(err: unknown): Record<string, unknown> {
    if (err instanceof Error) return { cause: err.message };
    return { cause: String(err) };
  }
}
