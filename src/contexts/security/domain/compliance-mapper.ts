// Compliance mapper — pure domain service.
//
// Turns a set of findings + the active policy catalogue into
// `ControlAssessment[]` for a chosen framework. We ship a seed
// catalogue for SOC2 and ISO27001; HIPAA, PCI-DSS, GDPR are
// stubbed with `na` until Phase 5 expands the mappings.
//
// The mapping rule is intentionally simple: each control declares
// a list of policy "tags" or `policyId`s; if any matching finding is
// `open` or `acknowledged`, the control is `fail`. If matching
// findings exist but are all `resolved`/`suppressed`, it is `pass`.
// If no policy is currently mapped, the control is `na`.

import type { FindingId, PolicyId } from '../../../shared/kernel';
import type { Finding } from './finding';
import type {
  ComplianceFramework,
  ControlAssessment,
  ControlStatus,
  CoverageScore,
  Scope,
} from './value-objects';

/**
 * Static control definition the mapper iterates over. `mapsTo` lists
 * either explicit `policyId`s or `tagPrefix:` patterns matched against
 * the policy's `name`. Phase 3 only ships explicit `policyName`
 * matches because we don't yet have a tag system.
 */
export interface ControlDefinition {
  controlId: string;
  framework: ComplianceFramework;
  title: string;
  category: string;
  /**
   * List of policy names whose findings, when present, fail this
   * control. Matched case-insensitively against
   * `SecurityPolicy.name`.
   */
  mapsToPolicyNames: string[];
  /**
   * List of explicit policy IDs that fail this control. Used when
   * loaders inject deterministic IDs.
   */
  mapsToPolicyIds?: string[];
  /** When set, the control is reported as `na` with this rationale. */
  notApplicable?: string;
}

/**
 * Seed control catalogue. Mappings target the BuiltinPolicyScanner's
 * policy names. Anything not directly testable (organisational
 * policy, manual sign-off) is reported `na` with a rationale.
 */
export const CONTROL_CATALOG: ControlDefinition[] = [
  // -------------------------------------------------------------------------
  // SOC2
  // -------------------------------------------------------------------------
  {
    controlId: 'CC6.1',
    framework: 'SOC2',
    title: 'Logical and Physical Access Controls',
    category: 'Common Criteria',
    mapsToPolicyNames: [
      'k8s.privileged',
      'k8s.runAsRoot',
      'k8s.hostNetwork',
      'k8s.hostPID',
      'k8s.hostIPC',
    ],
  },
  {
    controlId: 'CC6.6',
    framework: 'SOC2',
    title: 'Network Security',
    category: 'Common Criteria',
    mapsToPolicyNames: ['k8s.missingNetworkPolicy'],
  },
  {
    controlId: 'CC6.7',
    framework: 'SOC2',
    title: 'Restriction of Information Asset Access',
    category: 'Common Criteria',
    mapsToPolicyNames: ['k8s.secretInEnv'],
  },
  {
    controlId: 'CC7.1',
    framework: 'SOC2',
    title: 'System Operations / Change Management',
    category: 'Common Criteria',
    mapsToPolicyNames: ['k8s.latestImageTag', 'k8s.missingProbes'],
  },
  {
    controlId: 'CC7.2',
    framework: 'SOC2',
    title: 'Vulnerability Management',
    category: 'Common Criteria',
    mapsToPolicyNames: [],
    notApplicable:
      'No vulnerability scanner findings produced in this scope; assess once Trivy adapter is enabled.',
  },
  // -------------------------------------------------------------------------
  // ISO27001
  // -------------------------------------------------------------------------
  {
    controlId: 'A.5.15',
    framework: 'ISO27001',
    title: 'Access Control',
    category: 'Annex A',
    mapsToPolicyNames: ['k8s.privileged', 'k8s.runAsRoot'],
  },
  {
    controlId: 'A.8.9',
    framework: 'ISO27001',
    title: 'Configuration Management',
    category: 'Annex A',
    mapsToPolicyNames: [
      'k8s.hostNetwork',
      'k8s.hostPID',
      'k8s.hostIPC',
      'k8s.missingProbes',
      'k8s.missingResourceLimits',
    ],
  },
  {
    controlId: 'A.8.21',
    framework: 'ISO27001',
    title: 'Security of Network Services',
    category: 'Annex A',
    mapsToPolicyNames: ['k8s.missingNetworkPolicy'],
  },
  {
    controlId: 'A.8.24',
    framework: 'ISO27001',
    title: 'Use of Cryptography & Secrets',
    category: 'Annex A',
    mapsToPolicyNames: ['k8s.secretInEnv'],
  },
  {
    controlId: 'A.8.30',
    framework: 'ISO27001',
    title: 'Outsourced Development',
    category: 'Annex A',
    mapsToPolicyNames: [],
    notApplicable:
      'Process control; outside automated assessment scope in Phase 3.',
  },
  // -------------------------------------------------------------------------
  // HIPAA / PCI-DSS / GDPR (Phase 5 expansion)
  // -------------------------------------------------------------------------
  {
    controlId: '164.308(a)(1)(i)',
    framework: 'HIPAA',
    title: 'Security Management Process',
    category: 'Administrative Safeguards',
    mapsToPolicyNames: [],
    notApplicable: 'Awaiting Phase 5 HIPAA mapping expansion.',
  },
  {
    controlId: '6.4.2',
    framework: 'PCI-DSS',
    title: 'Web-Application Firewalls',
    category: 'Build & Maintain Secure Systems',
    mapsToPolicyNames: [],
    notApplicable: 'Awaiting Phase 5 PCI-DSS mapping expansion.',
  },
  {
    controlId: 'Art.32',
    framework: 'GDPR',
    title: 'Security of Processing',
    category: 'Chapter IV',
    mapsToPolicyNames: [],
    notApplicable: 'Awaiting Phase 5 GDPR mapping expansion.',
  },
];

export interface ComplianceMapperPolicy {
  id: PolicyId;
  name: string;
}

export class ComplianceMapper {
  /**
   * Build a `ControlAssessment[]` for the requested framework. Pure
   * function — given the same inputs it produces the same output, so
   * tests can compare snapshots verbatim.
   */
  assess(args: {
    framework: ComplianceFramework;
    scope: Scope;
    findings: ReadonlyArray<Finding>;
    policies: ReadonlyArray<ComplianceMapperPolicy>;
  }): { controls: ControlAssessment[]; overall: CoverageScore } {
    const policiesByName = new Map<string, PolicyId>();
    for (const p of args.policies) {
      policiesByName.set(p.name.toLowerCase(), p.id);
    }
    const findingsByPolicy = new Map<string, Finding[]>();
    for (const f of args.findings) {
      const list = findingsByPolicy.get(f.policyId) ?? [];
      list.push(f);
      findingsByPolicy.set(f.policyId, list);
    }

    const out: ControlAssessment[] = [];
    let pass = 0;
    let fail = 0;
    let partial = 0;
    let na = 0;

    for (const def of CONTROL_CATALOG) {
      if (def.framework !== args.framework) continue;
      if (def.notApplicable !== undefined) {
        out.push({
          controlId: def.controlId,
          framework: def.framework,
          title: def.title,
          category: def.category,
          status: 'na',
          supportingFindings: [],
          rationale: def.notApplicable,
        });
        na++;
        continue;
      }

      const mappedPolicyIds = new Set<string>();
      for (const name of def.mapsToPolicyNames) {
        const id = policiesByName.get(name.toLowerCase());
        if (id) mappedPolicyIds.add(id);
      }
      for (const id of def.mapsToPolicyIds ?? []) mappedPolicyIds.add(id);

      const supporting: FindingId[] = [];
      let openOrAck = 0;
      let resolvedOrSuppressed = 0;
      for (const id of mappedPolicyIds) {
        const list = findingsByPolicy.get(id) ?? [];
        for (const f of list) {
          supporting.push(f.id);
          if (f.status === 'open' || f.status === 'acknowledged') {
            openOrAck++;
          } else {
            resolvedOrSuppressed++;
          }
        }
      }

      let status: ControlStatus;
      let rationale: string;
      if (mappedPolicyIds.size === 0) {
        status = 'na';
        rationale = `No active policies map to ${def.controlId}.`;
        na++;
      } else if (openOrAck > 0 && resolvedOrSuppressed > 0) {
        status = 'partial';
        rationale = `${openOrAck} open + ${resolvedOrSuppressed} closed finding(s) for mapped policies.`;
        partial++;
      } else if (openOrAck > 0) {
        status = 'fail';
        rationale = `${openOrAck} open finding(s) for mapped policies.`;
        fail++;
      } else {
        // No findings at all → pass; or all closed → pass.
        status = 'pass';
        rationale =
          supporting.length === 0
            ? 'No findings against mapped policies.'
            : `All ${supporting.length} finding(s) closed.`;
        pass++;
      }
      out.push({
        controlId: def.controlId,
        framework: def.framework,
        title: def.title,
        category: def.category,
        status,
        supportingFindings: supporting,
        rationale,
      });
    }

    const total = pass + fail + partial + na;
    // Score = pass + 0.5*partial / (total - na). Reports 100 when
    // there are no applicable controls; rounds to integer.
    const denom = total - na;
    const ratio = denom === 0 ? 1 : (pass + 0.5 * partial) / denom;
    const overall: CoverageScore = {
      score: Math.round(ratio * 100),
      pass,
      fail,
      partial,
      na,
      total,
    };
    return { controls: out, overall };
  }

  /** Returns the unique frameworks the mapper knows about. */
  listFrameworks(): ComplianceFramework[] {
    const seen = new Set<ComplianceFramework>();
    for (const c of CONTROL_CATALOG) seen.add(c.framework);
    return Array.from(seen);
  }

  listControls(framework: ComplianceFramework): ControlDefinition[] {
    return CONTROL_CATALOG.filter(c => c.framework === framework);
  }
}
