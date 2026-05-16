// S3 implementation of `AuditArchiveStore`.
//
// The `@aws-sdk/client-s3` package is an OPTIONAL peer dependency: in
// most test environments it isn't installed and the adapter throws
// `NotConfiguredError` from the constructor. Mirrors the pattern used
// by `S3SnapshotArchiveAdapter` in the discovery context (DDD-06).
//
// Env contract:
//   - `AUDIT_ARCHIVE_BUCKET` (required) — destination bucket.
//   - `AWS_REGION`                       — defaults to us-east-1.
//   - `AUDIT_ARCHIVE_ENDPOINT` (optional) — for MinIO / localstack.
//   - `AUDIT_ARCHIVE_PREFIX`   (optional) — prepended to every key.
//
// Integrity: on upload we attach a `ChecksumSHA256` (base64) when the
// caller supplies a hex digest; S3 verifies it server-side and rejects
// mismatched bodies with a 400. On download we hand back raw bytes;
// the archive service re-hashes and compares.

import { createHash } from 'crypto';
import { NotConfiguredError, ProviderError } from '../../../../shared/errors';
import type {
  AuditArchiveStore,
  AuditArchiveUploadOpts,
  AuditArchiveUploadResult,
} from '../../domain/ports/archive-store';

/**
 * Minimal contract the adapter pulls from `@aws-sdk/client-s3`. We
 * intentionally type the surface we use rather than importing
 * `S3Client` types directly so the file compiles even when the SDK
 * isn't on disk.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/** Factory for the SDK. Production injects `defaultS3Factory`; tests inject a fake. */
export interface S3ClientFactory {
  loadModule(): {
    S3Client: new (config: Record<string, unknown>) => S3ClientLike;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
    ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
  } | null;
}

export interface S3AuditArchiveStoreEnv {
  AUDIT_ARCHIVE_BUCKET?: string;
  AWS_REGION?: string;
  AUDIT_ARCHIVE_ENDPOINT?: string;
  AUDIT_ARCHIVE_PREFIX?: string;
}

export interface S3AuditArchiveStoreOpts {
  env?: S3AuditArchiveStoreEnv;
  factory?: S3ClientFactory;
  /** Pre-built client (tests). When supplied we skip the SDK load. */
  client?: S3ClientLike;
  /** Pre-built command constructors (tests with `client`). */
  commands?: NonNullable<ReturnType<S3ClientFactory['loadModule']>>;
}

/**
 * Default factory loads the AWS SDK lazily via `require` so an absent
 * SDK collapses to a clean `NotConfiguredError` rather than a
 * MODULE_NOT_FOUND at typecheck time.
 */
export const defaultS3Factory: S3ClientFactory = {
  loadModule(): ReturnType<S3ClientFactory['loadModule']> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@aws-sdk/client-s3') as ReturnType<
        S3ClientFactory['loadModule']
      >;
      return mod;
    } catch {
      return null;
    }
  },
};

export class S3AuditArchiveStore implements AuditArchiveStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3ClientLike;
  private readonly cmds: NonNullable<ReturnType<S3ClientFactory['loadModule']>>;

  constructor(opts: S3AuditArchiveStoreOpts = {}) {
    const env = opts.env ?? (process.env as S3AuditArchiveStoreEnv);
    const bucket = env.AUDIT_ARCHIVE_BUCKET;
    if (!bucket || bucket === '') {
      throw new NotConfiguredError(
        'AUDIT_ARCHIVE_BUCKET env var is required for the S3 audit archive store'
      );
    }
    this.bucket = bucket;
    this.prefix = env.AUDIT_ARCHIVE_PREFIX ?? '';

    if (opts.client && opts.commands) {
      this.client = opts.client;
      this.cmds = opts.commands;
      return;
    }

    const factory = opts.factory ?? defaultS3Factory;
    const mod = factory.loadModule();
    if (!mod) {
      throw new NotConfiguredError(
        '@aws-sdk/client-s3 is not installed; install it as a peer dependency or use the local-fs adapter for tests/dev'
      );
    }
    this.cmds = mod;
    const config: Record<string, unknown> = {
      region: env.AWS_REGION ?? 'us-east-1',
    };
    if (env.AUDIT_ARCHIVE_ENDPOINT) {
      config['endpoint'] = env.AUDIT_ARCHIVE_ENDPOINT;
      config['forcePathStyle'] = true;
    }
    this.client = new mod.S3Client(config);
  }

  async upload(
    key: string,
    body: Uint8Array,
    opts: AuditArchiveUploadOpts = {}
  ): Promise<AuditArchiveUploadResult> {
    const fullKey = this.fullKey(key);
    const input: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: fullKey,
      Body: body,
      ContentType: opts.contentType ?? 'application/gzip',
      ContentLength: body.byteLength,
      ContentMD5: this.md5Base64(body),
    };
    if (opts.checksum) {
      input['ChecksumSHA256'] = this.hexToBase64(opts.checksum);
    }
    try {
      await this.client.send(new this.cmds.PutObjectCommand(input));
    } catch (err) {
      throw new ProviderError(
        's3 audit archive upload failed',
        this.detail(err, key)
      );
    }
    return {
      uri: `s3://${this.bucket}/${fullKey}`,
      size: body.byteLength,
    };
  }

  async exists(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    try {
      await this.client.send(
        new this.cmds.HeadObjectCommand({ Bucket: this.bucket, Key: fullKey })
      );
      return true;
    } catch (err) {
      if (this.isNotFound(err)) return false;
      throw new ProviderError(
        's3 audit archive head failed',
        this.detail(err, key)
      );
    }
  }

  async download(key: string): Promise<Uint8Array> {
    const fullKey = this.fullKey(key);
    try {
      const out = (await this.client.send(
        new this.cmds.GetObjectCommand({ Bucket: this.bucket, Key: fullKey })
      )) as { Body?: unknown };
      return await this.bodyToUint8Array(out.Body);
    } catch (err) {
      throw new ProviderError(
        's3 audit archive download failed',
        this.detail(err, key)
      );
    }
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    const full = this.fullKey(prefix);
    try {
      const out = (await this.client.send(
        new this.cmds.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: full,
          MaxKeys: limit,
        })
      )) as { Contents?: Array<{ Key?: string }> };
      const keys: string[] = [];
      for (const obj of out.Contents ?? []) {
        if (obj.Key) keys.push(this.stripPrefix(obj.Key));
      }
      return keys;
    } catch (err) {
      throw new ProviderError(
        's3 audit archive list failed',
        this.detail(err, prefix)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fullKey(key: string): string {
    if (!this.prefix) return key;
    return this.prefix.endsWith('/')
      ? `${this.prefix}${key}`
      : `${this.prefix}/${key}`;
  }

  private stripPrefix(key: string): string {
    if (!this.prefix) return key;
    const base = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
    return key.startsWith(base) ? key.slice(base.length) : key;
  }

  private md5Base64(body: Uint8Array): string {
    return createHash('md5').update(body).digest('base64');
  }

  private hexToBase64(hex: string): string {
    return Buffer.from(hex, 'hex').toString('base64');
  }

  private isNotFound(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
      Code?: string;
    };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
    if (e.Code === 'NoSuchKey') return true;
    return e.$metadata?.httpStatusCode === 404;
  }

  private async bodyToUint8Array(body: unknown): Promise<Uint8Array> {
    if (body == null) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    const maybeBlob = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof maybeBlob.arrayBuffer === 'function') {
      return new Uint8Array(await maybeBlob.arrayBuffer());
    }
    const maybeHelper = body as {
      transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof maybeHelper.transformToByteArray === 'function') {
      return await maybeHelper.transformToByteArray();
    }
    const chunks: Buffer[] = [];
    const iterable = body as AsyncIterable<Buffer>;
    for await (const chunk of iterable) {
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  private detail(err: unknown, key: string): Record<string, unknown> {
    const base: Record<string, unknown> = { key, bucket: this.bucket };
    if (err instanceof Error) base['cause'] = err.message;
    else base['cause'] = String(err);
    return base;
  }
}
