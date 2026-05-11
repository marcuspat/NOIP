// Factory that selects the right `SnapshotArchiveStore` for the
// current environment.
//
// Priority:
//   1. If `S3_ARCHIVE_BUCKET` is set AND the AWS SDK is installed →
//      `S3SnapshotArchiveAdapter`.
//   2. Otherwise → `LocalFsSnapshotArchiveAdapter` rooted at
//      `./.noip-archive` (or `LOCAL_ARCHIVE_ROOT` if set).
//
// The factory is intentionally synchronous: it's called once at
// composition root time and any operator misconfiguration surfaces
// at boot, not on the first cold archive.

import {
  LocalFsSnapshotArchiveAdapter,
  type LocalFsArchiveAdapterOpts,
} from './local-fs-archive-adapter';
import {
  S3SnapshotArchiveAdapter,
  defaultS3Factory,
  type S3ArchiveAdapterEnv,
  type S3ClientFactory,
  type S3SnapshotArchiveAdapterOpts,
} from './s3-archive-adapter';
import { NotConfiguredError } from '../../domain/archive-errors';
import type { SnapshotArchiveStore } from '../../domain/ports/snapshot-archive-store';

export interface CreateSnapshotArchiveStoreOpts {
  env?: S3ArchiveAdapterEnv & { LOCAL_ARCHIVE_ROOT?: string };
  /** Override for tests. */
  s3Factory?: S3ClientFactory;
  /** Pre-built S3 client/commands (tests). */
  s3?: Pick<S3SnapshotArchiveAdapterOpts, 'client' | 'commands'>;
  /** Override for tests / local-fs configuration. */
  localFs?: LocalFsArchiveAdapterOpts;
  /**
   * If `true` and `S3_ARCHIVE_BUCKET` is set but the SDK fails to
   * load, the factory throws instead of falling back to local-fs.
   * Production toggles this on.
   */
  strict?: boolean;
}

export function createSnapshotArchiveStore(
  opts: CreateSnapshotArchiveStoreOpts = {}
): SnapshotArchiveStore {
  const env =
    opts.env ?? (process.env as CreateSnapshotArchiveStoreOpts['env']);
  const bucket = env?.S3_ARCHIVE_BUCKET;
  if (bucket && bucket !== '') {
    try {
      const s3Opts: S3SnapshotArchiveAdapterOpts = {
        factory: opts.s3Factory ?? defaultS3Factory,
        ...(env ? { env } : {}),
        ...(opts.s3?.client ? { client: opts.s3.client } : {}),
        ...(opts.s3?.commands ? { commands: opts.s3.commands } : {}),
      };
      return new S3SnapshotArchiveAdapter(s3Opts);
    } catch (err) {
      if (opts.strict || !(err instanceof NotConfiguredError)) throw err;
      // Fall through to local-fs.
    }
  }

  const localOpts: LocalFsArchiveAdapterOpts = {
    ...(opts.localFs ?? {}),
    ...(env?.LOCAL_ARCHIVE_ROOT && !opts.localFs?.root
      ? { root: env.LOCAL_ARCHIVE_ROOT }
      : {}),
  };
  return new LocalFsSnapshotArchiveAdapter(localOpts);
}
