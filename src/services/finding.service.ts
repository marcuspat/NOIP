import { createHash } from 'crypto';
import { BaseService } from './base.service';
import {
  FindingModel,
  FindingCategory,
  FindingSeverity,
} from '../models/finding.model';

export interface FindingInput {
  ruleId: string;
  title: string;
  description: string;
  category: FindingCategory;
  severity: FindingSeverity;
  affectedResource: {
    apiVersion: string;
    kind: string;
    namespace?: string;
    name: string;
  };
  evidence?: string[];
  recommendation?: string;
}

export interface RecordFindingsResult {
  created: number;
  updated: number;
  resolved: number;
}

/**
 * Persists security/configuration findings as a deduplicated set per cluster.
 *
 * A finding's identity is the SHA-256 of (clusterId, ruleId, kind, name): the
 * same issue seen across repeated scans collapses to one row whose lastSeenAt
 * advances. Findings that were open but absent from the latest batch are
 * auto-resolved, giving an accurate "currently open" view.
 */
export class FindingService extends BaseService {
  constructor() {
    super('FindingService');
  }

  fingerprint(
    clusterId: string,
    ruleId: string,
    kind: string,
    name: string
  ): string {
    return createHash('sha256')
      .update(`${clusterId}|${ruleId}|${kind}|${name}`)
      .digest('hex');
  }

  async recordFindings(
    clusterId: string,
    snapshotId: string,
    inputs: FindingInput[]
  ): Promise<RecordFindingsResult> {
    const now = new Date();
    const seenFingerprints: string[] = [];
    let created = 0;
    let updated = 0;

    for (const input of inputs) {
      const fingerprint = this.fingerprint(
        clusterId,
        input.ruleId,
        input.affectedResource.kind,
        input.affectedResource.name
      );
      seenFingerprints.push(fingerprint);

      const existing = await FindingModel.findOne({ clusterId, fingerprint });
      if (existing) {
        existing.lastSeenAt = now;
        existing.severity = input.severity;
        existing.snapshotId = snapshotId;
        existing.evidence = input.evidence ?? existing.evidence;
        // A recurrence of a previously resolved/suppressed issue re-opens it.
        if (existing.status === 'resolved') {
          existing.status = 'open';
          existing.resolvedAt = undefined;
        }
        await existing.save();
        updated += 1;
      } else {
        await FindingModel.create({
          clusterId,
          fingerprint,
          ruleId: input.ruleId,
          title: input.title,
          description: input.description,
          category: input.category,
          severity: input.severity,
          status: 'open',
          affectedResource: input.affectedResource,
          evidence: input.evidence ?? [],
          recommendation: input.recommendation,
          firstSeenAt: now,
          lastSeenAt: now,
          snapshotId,
        });
        created += 1;
      }
    }

    // Auto-resolve findings that are still open but no longer observed.
    const resolveQuery: Record<string, unknown> = {
      clusterId,
      status: 'open',
    };
    if (seenFingerprints.length > 0) {
      resolveQuery.fingerprint = { $nin: seenFingerprints };
    }
    const resolveResult = await FindingModel.updateMany(resolveQuery, {
      $set: { status: 'resolved', resolvedAt: now },
    });
    const resolved = resolveResult.modifiedCount ?? 0;

    this.logOperation('Recorded findings', {
      clusterId,
      created,
      updated,
      resolved,
    });

    return { created, updated, resolved };
  }

  async getOpenFindings(clusterId: string) {
    return FindingModel.find({ clusterId, status: 'open' }).sort({
      severity: -1,
      lastSeenAt: -1,
    });
  }
}
