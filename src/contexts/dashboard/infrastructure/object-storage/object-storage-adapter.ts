// Composite + S3 adapter for the dashboard's report artifact tier.
//
// `createObjectStorageAdapter({...})` is the composition-root entry
// point. It tries the S3 adapter first (lazy-loading the AWS SDK like
// the discovery snapshot archive adapter) and falls back to the local
// filesystem adapter when S3 is not configured or the SDK isn't on
// disk. This means tests, CI, and local dev all "just work" without
// touching env vars.
//
// We keep S3 in this file rather than its own module because (a) the
// adapter is tiny — most of the surface is the lazy-load probe — and
// (b) the composite needs to know about both implementations.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { NotConfiguredError, ProviderError } from '../../../../shared/errors';
import type {
  ObjectPutOpts,
  ObjectPutResult,
  ObjectStorageAdapter,
} from '../../domain/ports/object-storage';
import {
  LocalFsObjectStorageAdapter,
  type LocalFsStorageAdapterOpts,
} from './local-fs-storage-adapter';

// ---------------------------------------------------------------------------
// S3 lazy-loader and adapter
// ---------------------------------------------------------------------------

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface DashboardS3Factory {
  loadModule(): {
    S3Client: new (config: Record<string, unknown>) => S3ClientLike;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  } | null;
}

export interface DashboardS3Env {
  DASHBOARD_S3_BUCKET?: string;
  AWS_REGION?: string;
  DASHBOARD_S3_ENDPOINT?: string;
  DASHBOARD_S3_PREFIX?: string;
}

export interface S3ObjectStorageAdapterOpts {
  env?: DashboardS3Env;
  factory?: DashboardS3Factory;
  client?: S3ClientLike;
  commands?: NonNullable<ReturnType<DashboardS3Factory['loadModule']>>;
}

export const defaultDashboardS3Factory: DashboardS3Factory = {
  loadModule(): ReturnType<DashboardS3Factory['loadModule']> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@aws-sdk/client-s3') as ReturnType<
        DashboardS3Factory['loadModule']
      >;
      return mod;
    } catch {
      return null;
    }
  },
};

export class S3ObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3ClientLike;
  private readonly cmds: NonNullable<
    ReturnType<DashboardS3Factory['loadModule']>
  >;

  constructor(opts: S3ObjectStorageAdapterOpts = {}) {
    const env = opts.env ?? (process.env as DashboardS3Env);
    const bucket = env.DASHBOARD_S3_BUCKET;
    if (!bucket || bucket === '') {
      throw new NotConfiguredError(
        'DASHBOARD_S3_BUCKET env var is required for the S3 dashboard storage adapter'
      );
    }
    this.bucket = bucket;
    this.prefix = env.DASHBOARD_S3_PREFIX ?? '';

    if (opts.client && opts.commands) {
      this.client = opts.client;
      this.cmds = opts.commands;
      return;
    }

    const factory = opts.factory ?? defaultDashboardS3Factory;
    const mod = factory.loadModule();
    if (!mod) {
      throw new NotConfiguredError(
        '@aws-sdk/client-s3 is not installed; use the local-fs adapter for tests/dev'
      );
    }
    this.cmds = mod;
    const config: Record<string, unknown> = {
      region: env.AWS_REGION ?? 'us-east-1',
    };
    if (env.DASHBOARD_S3_ENDPOINT) {
      config['endpoint'] = env.DASHBOARD_S3_ENDPOINT;
      config['forcePathStyle'] = true;
    }
    this.client = new mod.S3Client(config);
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: ObjectPutOpts = {}
  ): Promise<ObjectPutResult> {
    const fullKey = this.fullKey(key);
    const input: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: fullKey,
      Body: body,
      ContentType: opts.contentType ?? 'application/octet-stream',
      ContentLength: opts.contentLength ?? body.byteLength,
      ContentMD5: this.md5Base64(body),
    };
    try {
      await this.client.send(new this.cmds.PutObjectCommand(input));
    } catch (err) {
      throw new ProviderError('s3 dashboard put failed', this.detail(err, key));
    }
    return { uri: `s3://${this.bucket}/${fullKey}`, size: body.byteLength };
  }

  async putStream(
    key: string,
    body: Readable,
    opts: ObjectPutOpts = {}
  ): Promise<ObjectPutResult> {
    // S3 SDK v3 accepts a `Readable` body directly, but checksum +
    // length both need the whole payload, so we collect once and
    // delegate to `put`. For very large artifacts a future revision
    // can switch to `Upload` from `@aws-sdk/lib-storage`.
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return this.put(key, new Uint8Array(Buffer.concat(chunks)), opts);
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
        's3 dashboard head failed',
        this.detail(err, key)
      );
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const fullKey = this.fullKey(key);
    try {
      const out = (await this.client.send(
        new this.cmds.GetObjectCommand({ Bucket: this.bucket, Key: fullKey })
      )) as { Body?: unknown };
      return await this.bodyToUint8Array(out.Body);
    } catch (err) {
      throw new ProviderError('s3 dashboard get failed', this.detail(err, key));
    }
  }

  async getStream(key: string): Promise<Readable> {
    const bytes = await this.get(key);
    return Readable.from([Buffer.from(bytes)]);
  }

  private fullKey(key: string): string {
    if (!this.prefix) return key;
    return this.prefix.endsWith('/')
      ? `${this.prefix}${key}`
      : `${this.prefix}/${key}`;
  }

  private md5Base64(body: Uint8Array): string {
    return createHash('md5').update(body).digest('base64');
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
    for await (const chunk of iterable) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }

  private detail(err: unknown, key: string): Record<string, unknown> {
    const base: Record<string, unknown> = { key, bucket: this.bucket };
    base['cause'] = err instanceof Error ? err.message : String(err);
    return base;
  }
}

// ---------------------------------------------------------------------------
// Composite factory
// ---------------------------------------------------------------------------

export interface CreateObjectStorageAdapterOpts {
  /** Override env (tests). */
  env?: DashboardS3Env;
  /** Override the local-fs root. */
  localFs?: LocalFsStorageAdapterOpts;
  /** Pre-built S3 adapter (tests). */
  s3?: ObjectStorageAdapter;
  /** Pre-built local adapter (tests). */
  local?: ObjectStorageAdapter;
  /** SDK factory override (tests). */
  s3Factory?: DashboardS3Factory;
}

/**
 * Returns the appropriate adapter for the environment. Order of
 * preference:
 *   1. Caller-supplied adapter (`opts.s3` or `opts.local`).
 *   2. S3 — if `DASHBOARD_S3_BUCKET` is set AND the AWS SDK loads.
 *   3. Local filesystem.
 *
 * Failures while initialising the S3 adapter degrade silently to the
 * filesystem variant; we log nothing here because the caller is the
 * composition root and owns the logger.
 */
export function createObjectStorageAdapter(
  opts: CreateObjectStorageAdapterOpts = {}
): ObjectStorageAdapter {
  if (opts.s3) return opts.s3;
  if (opts.local) return opts.local;
  const env = opts.env ?? (process.env as DashboardS3Env);
  if (env.DASHBOARD_S3_BUCKET) {
    try {
      return new S3ObjectStorageAdapter({
        env,
        ...(opts.s3Factory ? { factory: opts.s3Factory } : {}),
      });
    } catch (err) {
      if (!(err instanceof NotConfiguredError)) throw err;
      // fall through to local-fs
    }
  }
  return new LocalFsObjectStorageAdapter(opts.localFs ?? {});
}
