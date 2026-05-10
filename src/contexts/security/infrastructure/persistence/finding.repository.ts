// Finding repository — Mongoose-backed.

import type { Model } from 'mongoose';
import type { ClusterId, FindingId, ScanId } from '../../../../shared/kernel';
import { Finding } from '../../domain/finding';
import type { FindingPersistence } from '../../domain/finding';
import type { FindingFilter, Scope } from '../../domain/value-objects';
import { FindingModel as DefaultModel } from './finding.schema';

export interface FindingRepository {
  save(finding: Finding): Promise<void>;
  saveMany(findings: ReadonlyArray<Finding>): Promise<void>;
  findById(id: FindingId): Promise<Finding | null>;
  findByFingerprint(
    clusterId: ClusterId,
    fingerprint: string
  ): Promise<Finding | null>;
  list(scope: Scope, filter?: FindingFilter): Promise<Finding[]>;
  listByScan(scanId: ScanId): Promise<Finding[]>;
  listOpenByScope(scope: Scope): Promise<Finding[]>;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export class MongooseFindingRepository implements FindingRepository {
  constructor(
    private readonly model: Model<FindingPersistence> = DefaultModel
  ) {}

  async save(finding: Finding): Promise<void> {
    const doc = finding.toPersistence();
    await this.model.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  }

  async saveMany(findings: ReadonlyArray<Finding>): Promise<void> {
    if (findings.length === 0) return;
    const ops = findings.map(f => {
      const doc = f.toPersistence();
      return {
        updateOne: {
          filter: { id: doc.id },
          update: { $set: doc },
          upsert: true,
        },
      };
    });
    await this.model.bulkWrite(ops);
  }

  async findById(id: FindingId): Promise<Finding | null> {
    const doc = await this.model
      .findOne({ id })
      .lean<FindingPersistence>()
      .exec();
    return doc ? Finding.fromPersistence(doc) : null;
  }

  async findByFingerprint(
    clusterId: ClusterId,
    fingerprint: string
  ): Promise<Finding | null> {
    const doc = await this.model
      .findOne({ 'scope.clusterId': clusterId, fingerprint })
      .lean<FindingPersistence>()
      .exec();
    return doc ? Finding.fromPersistence(doc) : null;
  }

  async list(scope: Scope, filter: FindingFilter = {}): Promise<Finding[]> {
    const query: Record<string, unknown> = {
      'scope.clusterId': scope.clusterId,
    };
    if (scope.namespace !== undefined) {
      query['scope.namespace'] = scope.namespace;
    }
    const statuses = asArray(filter.status);
    if (statuses.length > 0) query['status'] = { $in: statuses };
    const severities = asArray(filter.severity);
    if (severities.length > 0) query['severity'] = { $in: severities };
    if (filter.policyId !== undefined) query['policyId'] = filter.policyId;
    if (filter.scanId !== undefined) query['scanId'] = filter.scanId;
    if (filter.resourceKind !== undefined) {
      query['resource.kind'] = filter.resourceKind;
    }
    const docs = await this.model
      .find(query)
      .sort({ detectedAt: -1 })
      .limit(filter.limit ?? 500)
      .lean<FindingPersistence[]>()
      .exec();
    return docs.map(d => Finding.fromPersistence(d));
  }

  async listByScan(scanId: ScanId): Promise<Finding[]> {
    const docs = await this.model
      .find({ scanId })
      .lean<FindingPersistence[]>()
      .exec();
    return docs.map(d => Finding.fromPersistence(d));
  }

  async listOpenByScope(scope: Scope): Promise<Finding[]> {
    const query: Record<string, unknown> = {
      'scope.clusterId': scope.clusterId,
      status: { $in: ['open', 'acknowledged'] },
    };
    if (scope.namespace !== undefined) {
      query['scope.namespace'] = scope.namespace;
    }
    const docs = await this.model
      .find(query)
      .lean<FindingPersistence[]>()
      .exec();
    return docs.map(d => Finding.fromPersistence(d));
  }
}

export class InMemoryFindingRepository implements FindingRepository {
  private readonly findings = new Map<string, FindingPersistence>();

  async save(finding: Finding): Promise<void> {
    this.findings.set(finding.id, finding.toPersistence());
  }
  async saveMany(findings: ReadonlyArray<Finding>): Promise<void> {
    for (const f of findings) {
      this.findings.set(f.id, f.toPersistence());
    }
  }
  async findById(id: FindingId): Promise<Finding | null> {
    const doc = this.findings.get(id);
    return doc ? Finding.fromPersistence(doc) : null;
  }
  async findByFingerprint(
    clusterId: ClusterId,
    fingerprint: string
  ): Promise<Finding | null> {
    for (const doc of this.findings.values()) {
      if (
        doc.scope.clusterId === clusterId &&
        doc.fingerprint === fingerprint
      ) {
        return Finding.fromPersistence(doc);
      }
    }
    return null;
  }
  async list(scope: Scope, filter: FindingFilter = {}): Promise<Finding[]> {
    const statuses = asArray(filter.status);
    const severities = asArray(filter.severity);
    let docs = Array.from(this.findings.values()).filter(d => {
      if (d.scope.clusterId !== scope.clusterId) return false;
      if (
        scope.namespace !== undefined &&
        d.scope.namespace !== scope.namespace
      ) {
        return false;
      }
      if (statuses.length > 0 && !statuses.includes(d.status)) return false;
      if (severities.length > 0 && !severities.includes(d.severity)) {
        return false;
      }
      if (filter.policyId !== undefined && d.policyId !== filter.policyId) {
        return false;
      }
      if (filter.scanId !== undefined && d.scanId !== filter.scanId) {
        return false;
      }
      if (
        filter.resourceKind !== undefined &&
        d.resource.kind !== filter.resourceKind
      ) {
        return false;
      }
      return true;
    });
    docs = docs.sort((a, b) => (a.detectedAt > b.detectedAt ? -1 : 1));
    if (filter.limit !== undefined) docs = docs.slice(0, filter.limit);
    return docs.map(d => Finding.fromPersistence(d));
  }
  async listByScan(scanId: ScanId): Promise<Finding[]> {
    return Array.from(this.findings.values())
      .filter(d => d.scanId === scanId)
      .map(d => Finding.fromPersistence(d));
  }
  async listOpenByScope(scope: Scope): Promise<Finding[]> {
    return Array.from(this.findings.values())
      .filter(
        d =>
          d.scope.clusterId === scope.clusterId &&
          (d.status === 'open' || d.status === 'acknowledged') &&
          (scope.namespace === undefined ||
            d.scope.namespace === scope.namespace)
      )
      .map(d => Finding.fromPersistence(d));
  }
}
