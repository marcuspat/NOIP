// Local-filesystem implementation of `ObjectStorageAdapter`.
//
// Used by the unit suite and by developers who don't want to stand up
// S3. The on-disk layout mirrors the storage key so a later migration
// to S3 is a pure copy. Mirrors the discovery
// `LocalFsSnapshotArchiveAdapter` design.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../../../../shared/errors';
import type {
  ObjectPutOpts,
  ObjectPutResult,
  ObjectStorageAdapter,
} from '../../domain/ports/object-storage';

export interface LocalFsStorageAdapterOpts {
  /** Root directory. Defaults to `./.noip-dashboard-artifacts`. */
  root?: string;
}

export class LocalFsObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly root: string;

  constructor(opts: LocalFsStorageAdapterOpts = {}) {
    this.root =
      opts.root ?? path.resolve(process.cwd(), '.noip-dashboard-artifacts');
  }

  async put(
    key: string,
    body: Uint8Array,
    _opts: ObjectPutOpts = {}
  ): Promise<ObjectPutResult> {
    this.assertSafeKey(key);
    const target = path.join(this.root, key);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    } catch (err) {
      throw new ProviderError(`local-fs storage put failed for ${key}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return { uri: `file://${target}`, size: body.byteLength };
  }

  async putStream(
    key: string,
    body: Readable,
    _opts: ObjectPutOpts = {}
  ): Promise<ObjectPutResult> {
    this.assertSafeKey(key);
    const target = path.join(this.root, key);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const writer = createWriteStream(target);
      await pipeline(body, writer);
      const stats = await fs.stat(target);
      return { uri: `file://${target}`, size: stats.size };
    } catch (err) {
      throw new ProviderError(`local-fs storage putStream failed for ${key}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
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

  async get(key: string): Promise<Uint8Array> {
    this.assertSafeKey(key);
    try {
      const buf = await fs.readFile(path.join(this.root, key));
      return new Uint8Array(buf);
    } catch (err) {
      throw new ProviderError(`local-fs storage get failed for ${key}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getStream(key: string): Promise<Readable> {
    this.assertSafeKey(key);
    // Validate existence first so callers see a `ProviderError` rather
    // than a stream `error` event firing asynchronously.
    if (!(await this.exists(key))) {
      throw new ProviderError(`local-fs storage get failed for ${key}`, {
        cause: 'ENOENT',
      });
    }
    return createReadStream(path.join(this.root, key));
  }

  private assertSafeKey(key: string): void {
    if (key.includes('..') || path.isAbsolute(key)) {
      throw new ProviderError('storage key escapes root', { key });
    }
  }
}
