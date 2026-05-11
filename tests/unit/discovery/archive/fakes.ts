// Shared fakes for the archive test suites. Kept colocated so the
// specs read top-to-bottom without sprinkling helpers across the
// repository.

import { ResourceSnapshot } from '../../../../src/contexts/discovery/domain/resource-snapshot';
import type {
  ArchiveCandidate,
  ArchiveMarkPatch,
  ResourceSnapshotRepository,
} from '../../../../src/contexts/discovery/infrastructure/persistence/resource-snapshot.repository';
import type { ClusterId, SnapshotId } from '../../../../src/shared/kernel';
import type {
  ContentHash,
  KubernetesResourceRecord,
  ResourceRef,
  ResourceSnapshotRef,
  TimeRange,
} from '../../../../src/contexts/discovery/domain/value-objects';
import type {
  SnapshotArchiveStore,
  SnapshotArchiveUploadOpts,
  SnapshotArchiveUploadResult,
} from '../../../../src/contexts/discovery/domain/ports/snapshot-archive-store';

/**
 * In-memory `ResourceSnapshotRepository` that tracks the archive
 * metadata on each row. Returns aggregates via `ResourceSnapshot`
 * built from the stored persistence shape.
 */
export class InMemorySnapshotRepository implements ResourceSnapshotRepository {
  public readonly docs = new Map<
    SnapshotId,
    {
      id: SnapshotId;
      clusterId: ClusterId;
      scanId: string;
      takenAt: Date;
      hash: ContentHash;
      records: KubernetesResourceRecord[];
      archived: boolean;
      archiveUri?: string;
      archivedAt?: Date;
      archiveSha256?: string;
    }
  >();

  seed(args: {
    id: SnapshotId;
    clusterId: ClusterId;
    takenAt: Date;
    records?: KubernetesResourceRecord[];
    archived?: boolean;
    archivedAt?: Date;
    archiveUri?: string;
    archiveSha256?: string;
  }): void {
    this.docs.set(args.id, {
      id: args.id,
      clusterId: args.clusterId,
      scanId: 'seed-scan',
      takenAt: args.takenAt,
      hash: ('h-' + args.id) as ContentHash,
      records: args.records ?? [],
      archived: args.archived ?? false,
      ...(args.archiveUri !== undefined ? { archiveUri: args.archiveUri } : {}),
      ...(args.archivedAt !== undefined ? { archivedAt: args.archivedAt } : {}),
      ...(args.archiveSha256 !== undefined
        ? { archiveSha256: args.archiveSha256 }
        : {}),
    });
  }

  async save(snapshot: ResourceSnapshot): Promise<void> {
    const p = snapshot.toPersistence();
    this.docs.set(p.id as SnapshotId, {
      id: p.id as SnapshotId,
      clusterId: p.clusterId as ClusterId,
      scanId: p.scanId,
      takenAt: new Date(p.takenAt),
      hash: p.hash as ContentHash,
      records: p.records,
      archived: p.archived ?? false,
      ...(p.archiveUri !== undefined ? { archiveUri: p.archiveUri } : {}),
      ...(p.archivedAt !== undefined && p.archivedAt !== null
        ? {
            archivedAt:
              p.archivedAt instanceof Date
                ? p.archivedAt
                : new Date(p.archivedAt),
          }
        : {}),
      ...(p.archiveSha256 !== undefined
        ? { archiveSha256: p.archiveSha256 }
        : {}),
    });
  }

  async findById(id: SnapshotId): Promise<ResourceSnapshot | null> {
    const d = this.docs.get(id);
    if (!d) return null;
    return ResourceSnapshot.fromPersistence({
      id: d.id,
      clusterId: d.clusterId,
      scanId: d.scanId,
      takenAt: d.takenAt.toISOString(),
      hash: d.hash,
      counts: {
        total: d.records.length,
        nodeCount: 0,
        namespaceCount: 0,
        podCount: 0,
        serviceCount: 0,
        deploymentCount: 0,
      },
      records: d.records,
      archived: d.archived,
      ...(d.archiveUri !== undefined ? { archiveUri: d.archiveUri } : {}),
      ...(d.archivedAt !== undefined ? { archivedAt: d.archivedAt } : {}),
      ...(d.archiveSha256 !== undefined
        ? { archiveSha256: d.archiveSha256 }
        : {}),
    });
  }

  async findByHash(): Promise<ResourceSnapshot | null> {
    return null;
  }
  async findLatest(): Promise<ResourceSnapshot | null> {
    return null;
  }
  async list(
    _clusterId: ClusterId,
    _range?: TimeRange,
    _limit?: number
  ): Promise<ResourceSnapshotRef[]> {
    return [];
  }
  async findResource(
    _clusterId: ClusterId,
    _ref: ResourceRef
  ): Promise<KubernetesResourceRecord | null> {
    return null;
  }

  async findOlderThanForArchive(
    beforeDate: Date,
    limit: number,
    clusterId?: ClusterId
  ): Promise<ArchiveCandidate[]> {
    const out: ArchiveCandidate[] = [];
    for (const d of this.docs.values()) {
      if (d.archived) continue;
      if (d.takenAt.getTime() >= beforeDate.getTime()) continue;
      if (clusterId !== undefined && d.clusterId !== clusterId) continue;
      out.push({
        id: d.id,
        clusterId: d.clusterId,
        takenAt: d.takenAt,
        hash: d.hash,
        archived: false,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async markArchived(id: SnapshotId, patch: ArchiveMarkPatch): Promise<void> {
    const d = this.docs.get(id);
    if (!d) return;
    d.archived = true;
    d.archiveUri = patch.uri;
    d.archiveSha256 = patch.sha256;
    d.archivedAt = patch.at;
  }

  async findArchivedOlderThan(
    beforeDate: Date,
    limit: number
  ): Promise<ArchiveCandidate[]> {
    const out: ArchiveCandidate[] = [];
    for (const d of this.docs.values()) {
      if (!d.archived) continue;
      if (!d.archivedAt) continue;
      if (d.archivedAt.getTime() >= beforeDate.getTime()) continue;
      out.push({
        id: d.id,
        clusterId: d.clusterId,
        takenAt: d.takenAt,
        hash: d.hash,
        archived: true,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async hardDelete(ids: SnapshotId[]): Promise<{ deleted: number }> {
    let n = 0;
    for (const id of ids) {
      if (this.docs.delete(id)) n++;
    }
    return { deleted: n };
  }
}

/**
 * In-memory `SnapshotArchiveStore`. Records every upload/download/exists
 * call for assertions and supports a `corrupt` flag that swaps the
 * downloaded bytes so checksum verification fails.
 */
export class InMemoryArchiveStore implements SnapshotArchiveStore {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly checksums = new Map<string, string | undefined>();
  public corruptOnDownload = false;
  public failUpload = false;
  public failExists = false;
  public missingKeys = new Set<string>();
  public uploads: Array<{ key: string; size: number; checksum?: string }> = [];

  async upload(
    key: string,
    body: Uint8Array,
    opts?: SnapshotArchiveUploadOpts
  ): Promise<SnapshotArchiveUploadResult> {
    if (this.failUpload) throw new Error('upload boom');
    this.objects.set(key, new Uint8Array(body));
    this.checksums.set(key, opts?.checksum);
    this.uploads.push({
      key,
      size: body.byteLength,
      ...(opts?.checksum !== undefined ? { checksum: opts.checksum } : {}),
    });
    return { uri: `mem://${key}`, size: body.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    if (this.failExists) throw new Error('exists boom');
    if (this.missingKeys.has(key)) return false;
    return this.objects.has(key);
  }

  async download(key: string): Promise<Uint8Array> {
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`missing ${key}`);
    if (this.corruptOnDownload) {
      const corrupted = new Uint8Array(buf);
      // Flip a byte to break the hash. If empty, prepend a byte.
      if (corrupted.length === 0) return new Uint8Array([1]);
      corrupted[0] = (corrupted[0]! ^ 0xff) & 0xff;
      return corrupted;
    }
    return new Uint8Array(buf);
  }

  async list(prefix: string, limit = 1000): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.objects.keys()) {
      if (k.startsWith(prefix)) out.push(k);
      if (out.length >= limit) break;
    }
    return out.sort();
  }
}
