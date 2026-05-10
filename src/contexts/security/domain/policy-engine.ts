// PolicyEngine — pure domain service.
//
// Evaluates a single `SecurityPolicy` against a single
// `KubernetesResourceRecord` and produces zero or more `RawFinding`s.
// The actual checks live in the `BuiltinPolicyScanner` infrastructure
// adapter (so adapters can be swapped); this module is the contract
// shape and the registry that maps `policy.config.checkId` →
// implementation function.

import type { PolicyId } from '../../../shared/kernel';
import type { SecurityPolicy } from './security-policy';
import type { Evidence, ResourceRef, Severity } from './value-objects';

/**
 * Minimal record shape the engine evaluates. We accept Discovery's
 * `KubernetesResourceRecord` shape verbatim but spell it out here
 * to avoid a context boundary leak.
 */
export interface EvaluatedRecord {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  spec: unknown;
  status: unknown;
}

export interface PolicyEvaluation {
  policyId: PolicyId;
  resource: ResourceRef;
  severity: Severity;
  description: string;
  recommendation?: string;
  evidence: Evidence;
}

export interface PolicyCheckContext {
  /** Convenience reference back to the policy being evaluated. */
  policy: SecurityPolicy;
  /** Full set of records under evaluation; cluster-wide checks (e.g.
   * NetworkPolicy coverage) need a global view. */
  allRecords: ReadonlyArray<EvaluatedRecord>;
}

export type PolicyCheckFn = (
  record: EvaluatedRecord,
  ctx: PolicyCheckContext
) => PolicyEvaluation[];

export interface PolicyEngine {
  /**
   * Evaluate `policy` against `record`. Returns an empty array when
   * the policy does not apply (kind mismatch, etc.).
   */
  evaluate(
    policy: SecurityPolicy,
    record: EvaluatedRecord,
    allRecords: ReadonlyArray<EvaluatedRecord>
  ): PolicyEvaluation[];
}

/**
 * Helper: project an `EvaluatedRecord` onto the `ResourceRef` shape.
 */
export function refOf(record: EvaluatedRecord): ResourceRef {
  const ref: ResourceRef = {
    apiVersion: record.apiVersion,
    kind: record.kind,
    name: record.name,
  };
  if (record.namespace !== undefined) ref.namespace = record.namespace;
  return ref;
}
