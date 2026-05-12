// Trivy contract test — skipped when `trivy` is not on PATH.
//
// When present, scans a known vulnerable image and asserts the report
// schema. We use `alpine:3.10` which Trivy consistently flags with at
// least one CRITICAL vulnerability.

import {
  TrivyAdapter,
  NodeSubprocessRunner,
} from '../../../src/contexts/security/api';
import { announceBinary } from './_helpers/binary-availability';
import { VULNERABLE_IMAGE } from './_helpers/synthetic-workload';

describe('Trivy contract', () => {
  let available = false;
  beforeAll(async () => {
    available = await announceBinary('trivy');
  });

  it('reports at least one CRITICAL finding for alpine:3.10', async () => {
    if (!available) {
      console.log('[contract] trivy: skipping (binary unavailable)');
      return;
    }
    const adapter = new TrivyAdapter({
      realScannersFlag: () => true,
      runner: new NodeSubprocessRunner(),
      timeoutMs: 120_000,
      imagesOverride: [VULNERABLE_IMAGE],
    });
    const findings = await adapter.scan({ records: [] });
    expect(findings.length).toBeGreaterThan(0);
    const crit = findings.filter(f => f.severity === 'critical');
    expect(crit.length).toBeGreaterThan(0);
    // Schema sanity
    for (const f of crit.slice(0, 5)) {
      expect(typeof f.policyId).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(f.evidence.source).toBe('trivy');
    }
  });
});
