// ResourceSnapshot aggregate.
//
// Immutable, hash-addressable snapshot of every resource we successfully
// listed in a single scan. Equality is defined by `hash`; the
// `(clusterId, hash)` index in Mongo is unique so two consecutive scans
// that produced the same content collapse onto a single snapshot row
// (the second insert hits the unique index and the application service
// reuses the existing snapshot id).
//
// Invariants enforced here:
//   - `records` is frozen post-construction.
//   - `hash` matches `SnapshotHasher.hash(records)`.

import {
  newId,
  type ClusterId,
  type ScanId,
  type SnapshotId,
  type Instant,
} from '../../../shared/kernel';
import type { Clock } from '../../../shared/kernel';
import {
  emptyCounters,
  type ContentHash,
  type Counters,
  type KubernetesResourceRecord,
  type ResourceRef,
} from './value-objects';
import { SnapshotHasher } from './snapshot-hasher';

export interface ResourceSnapshotPersistence {
  id: string;
  clusterId: string;
  scanId: string;
  takenAt: string;
  hash: string;
  counts: Counters;
  records: KubernetesResourceRecord[];
  /** Archive metadata (added in the Snapshot Archiving follow-up). */
  archived?: boolean;
  archiveUri?: string;
  archivedAt?: Date | string | null;
  archiveSha256?: string;
}

/**
 * Computes per-kind counts from a flat list of records. Cheaper to
 * derive once than store on every record; called inside `create`.
 */
export function deriveCounters(records: KubernetesResourceRecord[]): Counters {
  const out = emptyCounters();
  out.total = records.length;
  for (const r of records) {
    switch (r.kind) {
      case 'Node':
        out.nodeCount++;
        break;
      case 'Namespace':
        out.namespaceCount++;
        break;
      case 'Pod':
        out.podCount++;
        break;
      case 'Service':
        out.serviceCount++;
        break;
      case 'Deployment':
        out.deploymentCount++;
        break;
      default:
        // Other kinds contribute to `total` only.
        break;
    }
  }
  return out;
}

/** Metadata attached when a snapshot is uploaded to cold storage. */
export interface ArchiveMetadata {
  archiveUri: string;
  archivedAt: Date;
  archiveSha256: string;
}

export class ResourceSnapshot {
  private readonly _id: SnapshotId;
  private readonly _clusterId: ClusterId;
  private readonly _scanId: ScanId;
  private readonly _takenAt: Instant;
  private readonly _hash: ContentHash;
  private readonly _counts: Counters;
  private readonly _records: ReadonlyArray<KubernetesResourceRecord>;
  private readonly _archived: boolean;
  private readonly _archiveUri: string | null;
  private readonly _archivedAt: Date | null;
  private readonly _archiveSha256: string | null;

  private constructor(args: {
    id: SnapshotId;
    clusterId: ClusterId;
    scanId: ScanId;
    takenAt: Instant;
    hash: ContentHash;
    counts: Counters;
    records: ReadonlyArray<KubernetesResourceRecord>;
    archived?: boolean;
    archiveUri?: string | null;
    archivedAt?: Date | null;
    archiveSha256?: string | null;
  }) {
    this._id = args.id;
    this._clusterId = args.clusterId;
    this._scanId = args.scanId;
    this._takenAt = args.takenAt;
    this._hash = args.hash;
    this._counts = args.counts;
    this._records = args.records;
    this._archived = args.archived ?? false;
    this._archiveUri = args.archiveUri ?? null;
    this._archivedAt = args.archivedAt ?? null;
    this._archiveSha256 = args.archiveSha256 ?? null;
    Object.freeze(this);
  }

  /**
   * Build a new snapshot from a list of records. Computes the hash
   * once and stores it; the records are also sorted (the sort happens
   * inside the hasher and we keep the sorted view for stable iteration).
   */
  static create(
    clusterId: ClusterId,
    scanId: ScanId,
    records: KubernetesResourceRecord[],
    clock: Clock,
    hasher: SnapshotHasher = new SnapshotHasher()
  ): ResourceSnapshot {
    const counts = deriveCounters(records);
    const hash = hasher.hash(records);
    const id = newId<SnapshotId>();
    return new ResourceSnapshot({
      id,
      clusterId,
      scanId,
      takenAt: clock.nowInstant(),
      hash,
      counts,
      records: Object.freeze(records.slice()),
    });
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------
  get id(): SnapshotId {
    return this._id;
  }
  get clusterId(): ClusterId {
    return this._clusterId;
  }
  get scanId(): ScanId {
    return this._scanId;
  }
  get takenAt(): Instant {
    return this._takenAt;
  }
  get hash(): ContentHash {
    return this._hash;
  }
  get counts(): Counters {
    return this._counts;
  }
  get records(): ReadonlyArray<KubernetesResourceRecord> {
    return this._records;
  }
  get archived(): boolean {
    return this._archived;
  }
  get archiveUri(): string | null {
    return this._archiveUri;
  }
  get archivedAt(): Date | null {
    return this._archivedAt;
  }
  get archiveSha256(): string | null {
    return this._archiveSha256;
  }

  /**
   * Produces a new snapshot instance flipped to archived. The original
   * instance is preserved (aggregate-as-value), and the resulting copy
   * keeps every other field identical — this is the only mutation
   * allowed on an otherwise immutable aggregate.
   *
   * The matching `discovery.snapshot.archived` event is NOT emitted
   * here; the `SnapshotArchiver` publishes it after the repository
   * write commits so the event reflects a durable side effect.
   */
  markArchived(meta: ArchiveMetadata): ResourceSnapshot {
    if (this._archived) {
      // Re-marking with the same uri is a no-op; with a different uri
      // we keep the existing one to make the operation idempotent.
      return this;
    }
    return new ResourceSnapshot({
      id: this._id,
      clusterId: this._clusterId,
      scanId: this._scanId,
      takenAt: this._takenAt,
      hash: this._hash,
      counts: this._counts,
      records: this._records,
      archived: true,
      archiveUri: meta.archiveUri,
      archivedAt: meta.archivedAt,
      archiveSha256: meta.archiveSha256,
    });
  }

  /** Find a single record by ref. O(n); callers that need many lookups
   * should build their own map. */
  findResource(ref: ResourceRef): KubernetesResourceRecord | null {
    for (const r of this._records) {
      if (
        r.apiVersion === ref.apiVersion &&
        r.kind === ref.kind &&
        (r.namespace ?? '') === (ref.namespace ?? '') &&
        r.name === ref.name
      ) {
        return r;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------
  static fromPersistence(doc: ResourceSnapshotPersistence): ResourceSnapshot {
    return new ResourceSnapshot({
      id: doc.id as SnapshotId,
      clusterId: doc.clusterId as ClusterId,
      scanId: doc.scanId as ScanId,
      takenAt: doc.takenAt as Instant,
      hash: doc.hash as ContentHash,
      counts: doc.counts,
      records: Object.freeze(doc.records.slice()),
      archived: doc.archived ?? false,
      archiveUri: doc.archiveUri ?? null,
      archivedAt:
        doc.archivedAt == null
          ? null
          : doc.archivedAt instanceof Date
            ? doc.archivedAt
            : new Date(doc.archivedAt),
      archiveSha256: doc.archiveSha256 ?? null,
    });
  }

  toPersistence(): ResourceSnapshotPersistence {
    const base: ResourceSnapshotPersistence = {
      id: this._id,
      clusterId: this._clusterId,
      scanId: this._scanId,
      takenAt: this._takenAt,
      hash: this._hash,
      counts: this._counts,
      records: this._records.slice(),
    };
    if (this._archived) {
      base.archived = true;
      if (this._archiveUri !== null) base.archiveUri = this._archiveUri;
      if (this._archivedAt !== null) base.archivedAt = this._archivedAt;
      if (this._archiveSha256 !== null)
        base.archiveSha256 = this._archiveSha256;
    }
    return base;
  }
}
