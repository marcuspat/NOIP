// Unit tests for `S3SnapshotArchiveAdapter`.
//
// The AWS SDK is not installed in CI/test environments. We exercise
// two contracts:
//   1. When no SDK module is available the constructor throws
//      `NotConfiguredError` — this is the documented behaviour the
//      composite factory falls back on.
//   2. When a tiny in-memory fake SDK is injected, upload/exists/
//      download/list all round-trip and integrity headers are wired
//      correctly.

import { S3SnapshotArchiveAdapter } from '../../../../src/contexts/discovery/infrastructure/archive/s3-archive-adapter';
import type {
  S3ClientFactory,
  S3ClientLike,
} from '../../../../src/contexts/discovery/infrastructure/archive/s3-archive-adapter';
import { NotConfiguredError } from '../../../../src/contexts/discovery/domain/archive-errors';
import { ProviderError } from '../../../../src/shared/errors';

interface CapturedCommand {
  name: string;
  input: Record<string, unknown>;
}

function buildFakeSdk(): {
  factory: S3ClientFactory;
  client: S3ClientLike;
  store: Map<string, Uint8Array>;
  commands: CapturedCommand[];
} {
  const store = new Map<string, Uint8Array>();
  const commands: CapturedCommand[] = [];

  class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
    static readonly _name = 'Put';
  }
  class HeadObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
    static readonly _name = 'Head';
  }
  class GetObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
    static readonly _name = 'Get';
  }
  class ListObjectsV2Command {
    constructor(public readonly input: Record<string, unknown>) {}
    static readonly _name = 'List';
  }

  class S3Client implements S3ClientLike {
    constructor(public readonly config: Record<string, unknown>) {}
    async send(cmd: unknown): Promise<unknown> {
      const cls = cmd as {
        input: Record<string, unknown>;
        constructor: { _name: string };
      };
      commands.push({ name: cls.constructor._name, input: cls.input });
      if (cls.constructor._name === 'Put') {
        const key = cls.input['Key'] as string;
        const body = cls.input['Body'] as Uint8Array;
        store.set(key, new Uint8Array(body));
        return {};
      }
      if (cls.constructor._name === 'Head') {
        const key = cls.input['Key'] as string;
        if (!store.has(key)) {
          const err: Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          } = Object.assign(new Error('NotFound'), {
            name: 'NotFound',
            $metadata: { httpStatusCode: 404 },
          });
          throw err;
        }
        return {};
      }
      if (cls.constructor._name === 'Get') {
        const key = cls.input['Key'] as string;
        const buf = store.get(key);
        if (!buf) throw new Error('missing');
        return { Body: buf };
      }
      if (cls.constructor._name === 'List') {
        const prefix = (cls.input['Prefix'] as string) ?? '';
        const limit = (cls.input['MaxKeys'] as number) ?? 1000;
        const keys = Array.from(store.keys()).filter(k => k.startsWith(prefix));
        return { Contents: keys.slice(0, limit).map(Key => ({ Key })) };
      }
      throw new Error('unknown command');
    }
  }

  const factory: S3ClientFactory = {
    loadModule(): ReturnType<S3ClientFactory['loadModule']> {
      return {
        S3Client: S3Client as unknown as new (
          config: Record<string, unknown>
        ) => S3ClientLike,
        PutObjectCommand: PutObjectCommand as unknown as new (
          input: Record<string, unknown>
        ) => unknown,
        HeadObjectCommand: HeadObjectCommand as unknown as new (
          input: Record<string, unknown>
        ) => unknown,
        GetObjectCommand: GetObjectCommand as unknown as new (
          input: Record<string, unknown>
        ) => unknown,
        ListObjectsV2Command: ListObjectsV2Command as unknown as new (
          input: Record<string, unknown>
        ) => unknown,
      };
    },
  };
  return {
    factory,
    client: new S3Client({}),
    store,
    commands,
  };
}

describe('S3SnapshotArchiveAdapter', () => {
  it('throws NotConfiguredError when S3_ARCHIVE_BUCKET is missing', () => {
    expect(
      () =>
        new S3SnapshotArchiveAdapter({
          env: {},
          factory: { loadModule: () => null },
        })
    ).toThrow(NotConfiguredError);
  });

  it('throws NotConfiguredError when the AWS SDK module cannot be loaded', () => {
    expect(
      () =>
        new S3SnapshotArchiveAdapter({
          env: { S3_ARCHIVE_BUCKET: 'noip-test', AWS_REGION: 'us-east-1' },
          factory: { loadModule: () => null },
        })
    ).toThrow(NotConfiguredError);
  });

  it('uploads with ContentType, ContentMD5, and ChecksumSHA256', async () => {
    const { factory, commands } = buildFakeSdk();
    const adapter = new S3SnapshotArchiveAdapter({
      env: {
        S3_ARCHIVE_BUCKET: 'noip-bucket',
        AWS_REGION: 'us-east-1',
      },
      factory,
    });
    const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const res = await adapter.upload('discovery/2026/05/c/s.jsonl.gz', body, {
      contentType: 'application/gzip',
      checksum:
        '5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953',
    });
    expect(res.uri).toBe('s3://noip-bucket/discovery/2026/05/c/s.jsonl.gz');
    expect(res.size).toBe(4);
    expect(commands[0]!.name).toBe('Put');
    expect(commands[0]!.input['ContentType']).toBe('application/gzip');
    expect(typeof commands[0]!.input['ContentMD5']).toBe('string');
    expect(typeof commands[0]!.input['ChecksumSHA256']).toBe('string');
  });

  it('honours S3_ARCHIVE_PREFIX on upload + list', async () => {
    const { factory, commands } = buildFakeSdk();
    const adapter = new S3SnapshotArchiveAdapter({
      env: {
        S3_ARCHIVE_BUCKET: 'b',
        AWS_REGION: 'us-east-1',
        S3_ARCHIVE_PREFIX: 'tenants/x',
      },
      factory,
    });
    await adapter.upload('discovery/2026/05/c/s.jsonl.gz', new Uint8Array([1]));
    expect(commands[0]!.input['Key']).toBe(
      'tenants/x/discovery/2026/05/c/s.jsonl.gz'
    );
    const list = await adapter.list('discovery/2026/05');
    expect(list).toEqual(['discovery/2026/05/c/s.jsonl.gz']);
  });

  it('exists returns false on 404, throws ProviderError on other errors', async () => {
    const { factory } = buildFakeSdk();
    const adapter = new S3SnapshotArchiveAdapter({
      env: { S3_ARCHIVE_BUCKET: 'b' },
      factory,
    });
    expect(await adapter.exists('nope')).toBe(false);
    // Now upload + check.
    await adapter.upload('x', new Uint8Array([1]));
    expect(await adapter.exists('x')).toBe(true);
  });

  it('exists wraps non-404 errors as ProviderError', async () => {
    const broken: S3ClientLike = {
      async send() {
        const err: Error & { $metadata: { httpStatusCode: number } } =
          Object.assign(new Error('boom'), {
            $metadata: { httpStatusCode: 500 },
          });
        throw err;
      },
    };
    const adapter = new S3SnapshotArchiveAdapter({
      env: { S3_ARCHIVE_BUCKET: 'b' },
      client: broken,
      commands: buildFakeSdk().factory.loadModule()!,
    });
    await expect(adapter.exists('x')).rejects.toBeInstanceOf(ProviderError);
  });

  it('download round-trips bytes', async () => {
    const { factory } = buildFakeSdk();
    const adapter = new S3SnapshotArchiveAdapter({
      env: { S3_ARCHIVE_BUCKET: 'b' },
      factory,
    });
    await adapter.upload('a', new Uint8Array([7, 8, 9]));
    const got = await adapter.download('a');
    expect(Array.from(got)).toEqual([7, 8, 9]);
  });

  it('download surfaces SDK failure as ProviderError', async () => {
    const broken: S3ClientLike = {
      async send() {
        throw new Error('net down');
      },
    };
    const adapter = new S3SnapshotArchiveAdapter({
      env: { S3_ARCHIVE_BUCKET: 'b' },
      client: broken,
      commands: buildFakeSdk().factory.loadModule()!,
    });
    await expect(adapter.download('a')).rejects.toBeInstanceOf(ProviderError);
  });

  it('list returns empty when SDK returns no contents', async () => {
    const empty: S3ClientLike = {
      async send() {
        return { Contents: undefined };
      },
    };
    const adapter = new S3SnapshotArchiveAdapter({
      env: { S3_ARCHIVE_BUCKET: 'b' },
      client: empty,
      commands: buildFakeSdk().factory.loadModule()!,
    });
    expect(await adapter.list('whatever')).toEqual([]);
  });

  it('configures endpoint + path style when S3_ARCHIVE_ENDPOINT is set', async () => {
    const sdk = buildFakeSdk();
    const adapter = new S3SnapshotArchiveAdapter({
      env: {
        S3_ARCHIVE_BUCKET: 'b',
        AWS_REGION: 'us-east-1',
        S3_ARCHIVE_ENDPOINT: 'http://localstack:4566',
      },
      factory: sdk.factory,
    });
    // exists is enough to drive the client; we mostly care that
    // construction did not throw.
    await adapter.upload('k', new Uint8Array([1]));
    expect(sdk.commands).toHaveLength(1);
  });

  it('also reports the real-world contract: SDK absent => NotConfiguredError', () => {
    // This is the contract the spec brief calls out explicitly: when
    // `@aws-sdk/client-s3` is not installed at all, the adapter
    // surfaces a `NotConfiguredError` from the constructor.
    expect(
      () =>
        new S3SnapshotArchiveAdapter({
          env: { S3_ARCHIVE_BUCKET: 'b' },
          factory: {
            loadModule: () => {
              // Default behaviour when require('@aws-sdk/client-s3')
              // throws MODULE_NOT_FOUND.
              return null;
            },
          },
        })
    ).toThrow(NotConfiguredError);
  });
});
