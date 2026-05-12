// kube-linter contract test — skipped when binary is absent.
//
// Runs kube-linter against a deliberately-bad Pod fixture and asserts
// at least one finding comes back.

import { rm } from 'node:fs/promises';
import {
  KubeLinterAdapter,
  NodeSubprocessRunner,
} from '../../../src/contexts/security/api';
import { announceBinary } from './_helpers/binary-availability';
import {
  writeBadPodFixture,
  syntheticInput,
} from './_helpers/synthetic-workload';

describe('kube-linter contract', () => {
  let available = false;
  let fixturePath: string | undefined;

  beforeAll(async () => {
    available = await announceBinary('kube-linter');
    if (available) {
      const fix = await writeBadPodFixture();
      fixturePath = fix.dir;
    }
  });

  afterAll(async () => {
    if (fixturePath) {
      await rm(fixturePath, { recursive: true, force: true });
    }
  });

  it('flags the privileged pod fixture as failing', async () => {
    if (!available) {
      console.log('[contract] kube-linter: skipping (binary unavailable)');
      return;
    }
    const adapter = new KubeLinterAdapter({
      realScannersFlag: () => true,
      runner: new NodeSubprocessRunner(),
      timeoutMs: 60_000,
    });
    const findings = await adapter.scan(syntheticInput());
    expect(findings.length).toBeGreaterThan(0);
    const checks = findings.map(f => f.evidence.data?.['check']);
    // We expect at least the privileged-container or run-as-non-root
    // check to fire on the synthetic bad pod.
    expect(checks.some(c => typeof c === 'string')).toBe(true);
  });
});
