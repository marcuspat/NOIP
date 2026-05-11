// Unit tests for `LocalFsSnapshotArchiveAdapter`.
//
// Each test uses a fresh temp directory under `os.tmpdir()` and tears
// it down at the end so reruns are isolated.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { LocalFsSnapshotArchiveAdapter } from '../../../../src/contexts/discovery/infrastructure/archive/local-fs-archive-adapter';
import { ProviderError } from '../../../../src/shared/errors';

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'noip-archive-test-'));
}

describe('LocalFsSnapshotArchiveAdapter', () => {
  let root: string;
  let adapter: LocalFsSnapshotArchiveAdapter;

  beforeEach(async () => {
    root = await tempRoot();
    adapter = new LocalFsSnapshotArchiveAdapter({ root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uploads, exists, and downloads round-trip', async () => {
    const key = 'discovery/2026/05/c-1/s-1.jsonl.gz';
    const payload = gzipSync(Buffer.from('{"hello":"world"}\n', 'utf8'));
    const res = await adapter.upload(key, payload, {
      contentType: 'application/gzip',
      checksum: 'abc',
    });
    expect(res.uri.startsWith('file://')).toBe(true);
    expect(res.size).toBe(payload.byteLength);

    expect(await adapter.exists(key)).toBe(true);
    expect(await adapter.exists('discovery/2026/05/c-1/missing.gz')).toBe(
      false
    );

    const back = await adapter.download(key);
    expect(Buffer.from(back).toString('utf8')).toBe(
      Buffer.from(payload).toString('utf8')
    );
    expect(gunzipSync(Buffer.from(back)).toString('utf8')).toBe(
      '{"hello":"world"}\n'
    );
  });

  it('writes a sidecar sha256 file when checksum is supplied', async () => {
    const key = 'discovery/2026/05/c-1/s-1.jsonl.gz';
    await adapter.upload(key, new Uint8Array([1, 2, 3]), {
      checksum: 'deadbeef',
    });
    const sidecar = await fs.readFile(`${root}/${key}.sha256`, 'utf8');
    expect(sidecar.trim()).toBe('deadbeef');
  });

  it('list() returns archive keys (filtering sidecars) under a prefix', async () => {
    await adapter.upload('discovery/2026/05/c-1/a.gz', new Uint8Array([1]), {
      checksum: 'x',
    });
    await adapter.upload('discovery/2026/05/c-1/b.gz', new Uint8Array([2]), {
      checksum: 'y',
    });
    await adapter.upload('discovery/2026/06/c-1/c.gz', new Uint8Array([3]));
    const may = await adapter.list('discovery/2026/05');
    expect(may.sort()).toEqual([
      'discovery/2026/05/c-1/a.gz',
      'discovery/2026/05/c-1/b.gz',
    ]);
    const all = await adapter.list('discovery/2026');
    expect(all).toHaveLength(3);
  });

  it('list() respects the limit argument', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.upload(
        `discovery/2026/05/c-1/${i}.gz`,
        new Uint8Array([i])
      );
    }
    const out = await adapter.list('discovery/2026/05', 3);
    expect(out).toHaveLength(3);
  });

  it('list() returns an empty array when no objects match', async () => {
    expect(await adapter.list('nope/')).toEqual([]);
  });

  it('rejects keys with .. traversal', async () => {
    await expect(
      adapter.upload('../escape.gz', new Uint8Array([1]))
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(adapter.exists('../escape.gz')).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('rejects absolute keys', async () => {
    await expect(
      adapter.upload('/etc/passwd', new Uint8Array([1]))
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('download() throws ProviderError on missing keys', async () => {
    await expect(adapter.download('missing.gz')).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  it('the key layout is deterministic across runs (same key -> same path)', async () => {
    const adapter2 = new LocalFsSnapshotArchiveAdapter({ root });
    const key = 'discovery/2026/05/c/s.jsonl.gz';
    await adapter.upload(key, new Uint8Array([7, 7, 7]));
    expect(await adapter2.exists(key)).toBe(true);
    const got = await adapter2.download(key);
    expect(Array.from(got)).toEqual([7, 7, 7]);
  });
});
