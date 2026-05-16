// RetentionPolicy aggregate (DDD-11 §"Aggregates").
//
// A retention policy declares two windows for a collection:
//   - `archiveAfterDays` — when entries become eligible for cold-tier
//     export by `ArchiveService.archiveOlderThan(days)`.
//   - `retentionDays` — when entries become eligible for hard deletion
//     from Mongo. Entries are only deleted IF they have been archived
//     and verified.
//
// Invariants:
//   - `archiveAfterDays <= retentionDays`.
//   - Once `immutable=true`, the policy can only be tightened (longer
//     retention, earlier archive).
//
// Policies are loaded once per pod at composition-root time and cached
// on the service. There is no live reload path — operators bump the
// docs in Mongo and roll the deployment.

import type { PolicyId } from '../../../shared/kernel';
import { ValidationError } from '../../../shared/errors';

/** Collections we know how to archive + retain. Adding a third is a one-line change. */
export type RetentionCollection = 'auditLogs' | 'securityEvents';

export interface RetentionPolicyProps {
  id: PolicyId;
  collection: RetentionCollection;
  retentionDays: number;
  archiveAfterDays: number;
  immutable: boolean;
}

/**
 * Default retention windows applied when no row exists in
 * `retentionPolicies` for a given collection. The defaults are
 * intentionally conservative (long retention, late archive) so
 * forgetting to seed a policy never drops data.
 */
export const DEFAULT_RETENTION: Readonly<
  Record<
    RetentionCollection,
    { archiveAfterDays: number; retentionDays: number }
  >
> = {
  auditLogs: { archiveAfterDays: 90, retentionDays: 2555 /* 7 years */ },
  securityEvents: { archiveAfterDays: 90, retentionDays: 365 },
};

export class RetentionPolicy {
  readonly id: PolicyId;
  readonly collection: RetentionCollection;
  readonly retentionDays: number;
  readonly archiveAfterDays: number;
  readonly immutable: boolean;

  private constructor(props: RetentionPolicyProps) {
    this.id = props.id;
    this.collection = props.collection;
    this.retentionDays = props.retentionDays;
    this.archiveAfterDays = props.archiveAfterDays;
    this.immutable = props.immutable;
  }

  static create(props: RetentionPolicyProps): RetentionPolicy {
    assertInvariants(props);
    return new RetentionPolicy(props);
  }

  /**
   * Produce a new RetentionPolicy with the supplied tightening edits.
   * Throws if the proposed change would loosen the policy or violate
   * `archiveAfterDays <= retentionDays`.
   *
   * "Tighten" means:
   *   - Longer retention (data lives longer = stricter).
   *   - Earlier archive (cold-tier sooner = stricter from a hot-tier
   *     standpoint).
   */
  tighten(edits: {
    retentionDays?: number;
    archiveAfterDays?: number;
  }): RetentionPolicy {
    const next: RetentionPolicyProps = {
      id: this.id,
      collection: this.collection,
      retentionDays: edits.retentionDays ?? this.retentionDays,
      archiveAfterDays: edits.archiveAfterDays ?? this.archiveAfterDays,
      immutable: this.immutable,
    };
    if (this.immutable) {
      if (next.retentionDays < this.retentionDays) {
        throw new ValidationError(
          'immutable policy: retentionDays may only increase',
          { current: this.retentionDays, proposed: next.retentionDays }
        );
      }
      if (next.archiveAfterDays > this.archiveAfterDays) {
        throw new ValidationError(
          'immutable policy: archiveAfterDays may only decrease',
          {
            current: this.archiveAfterDays,
            proposed: next.archiveAfterDays,
          }
        );
      }
    }
    assertInvariants(next);
    return new RetentionPolicy(next);
  }

  toJSON(): RetentionPolicyProps {
    return {
      id: this.id,
      collection: this.collection,
      retentionDays: this.retentionDays,
      archiveAfterDays: this.archiveAfterDays,
      immutable: this.immutable,
    };
  }
}

function assertInvariants(props: RetentionPolicyProps): void {
  if (!Number.isFinite(props.retentionDays) || props.retentionDays <= 0) {
    throw new ValidationError('retentionDays must be a positive number', {
      retentionDays: props.retentionDays,
    });
  }
  if (!Number.isFinite(props.archiveAfterDays) || props.archiveAfterDays <= 0) {
    throw new ValidationError('archiveAfterDays must be a positive number', {
      archiveAfterDays: props.archiveAfterDays,
    });
  }
  if (props.archiveAfterDays > props.retentionDays) {
    throw new ValidationError('archiveAfterDays must be <= retentionDays', {
      archiveAfterDays: props.archiveAfterDays,
      retentionDays: props.retentionDays,
    });
  }
}
