// Severity classifier — CVSS boundaries.

import {
  severityFromCvss,
  severityForK8sCategory,
} from '../../../src/contexts/security/domain/severity-classifier';

describe('severityFromCvss', () => {
  it.each<[number, string]>([
    [-1, 'low'],
    [0, 'low'],
    [3.9, 'low'],
    [4.0, 'medium'],
    [6.9, 'medium'],
    [7.0, 'high'],
    [8.9, 'high'],
    [9.0, 'critical'],
    [10.0, 'critical'],
  ])('CVSS %s → %s', (score, expected) => {
    expect(severityFromCvss(score)).toBe(expected);
  });

  it('NaN/Infinity collapse to low (non-finite)', () => {
    expect(severityFromCvss(Number.NaN)).toBe('low');
    expect(severityFromCvss(Number.POSITIVE_INFINITY)).toBe('low');
  });
});

describe('severityForK8sCategory', () => {
  it('maps known categories', () => {
    expect(severityForK8sCategory('k8s.privileged')).toBe('critical');
    expect(severityForK8sCategory('k8s.runAsRoot')).toBe('high');
    expect(severityForK8sCategory('k8s.missingNetworkPolicy')).toBe('medium');
    expect(severityForK8sCategory('k8s.latestImageTag')).toBe('low');
  });

  it('falls back to medium for unknown category', () => {
    expect(severityForK8sCategory('k8s.unknown.foo')).toBe('medium');
  });
});
