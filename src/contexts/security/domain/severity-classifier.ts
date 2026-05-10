// Severity classifier — pure domain service.
//
// Maps raw signals (CVSS scores, K8s misconfig categories) to the
// project-wide `Severity` ladder. The CVSS table follows the FIRST.org
// v3 score-to-rating bands.

import type { Severity } from './value-objects';

/**
 * CVSS v3 → severity. Bands per FIRST.org:
 *   0.0       → low (we treat 0 as a degenerate signal but still low)
 *   0.1–3.9   → low
 *   4.0–6.9   → medium
 *   7.0–8.9   → high
 *   9.0–10.0  → critical
 */
export function severityFromCvss(score: number): Severity {
  if (!Number.isFinite(score) || score < 0) return 'low';
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  return 'low';
}

/**
 * Mapping from K8s misconfig category to severity. Used by the
 * BuiltinPolicyScanner so the policy → severity table is in one place.
 */
export const K8S_CATEGORY_SEVERITY: Readonly<Record<string, Severity>> = {
  'k8s.privileged': 'critical',
  'k8s.runAsRoot': 'high',
  'k8s.hostNetwork': 'high',
  'k8s.hostPID': 'high',
  'k8s.hostIPC': 'high',
  'k8s.missingNetworkPolicy': 'medium',
  'k8s.secretInEnv': 'high',
  'k8s.latestImageTag': 'low',
  'k8s.missingProbes': 'low',
  'k8s.missingResourceLimits': 'low',
};

export function severityForK8sCategory(category: string): Severity {
  return K8S_CATEGORY_SEVERITY[category] ?? 'medium';
}

export const SeverityClassifier = {
  fromCvss: severityFromCvss,
  forK8sCategory: severityForK8sCategory,
};
