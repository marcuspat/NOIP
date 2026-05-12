// gitleaks contract test — skipped when binary is absent. Writes a
// canned secret-shaped file to a temp dir and asserts gitleaks finds
// at least one leak.

import { rm } from 'node:fs/promises';
import {
  SecretsScannerAdapter,
  NodeSubprocessRunner,
} from '../../../src/contexts/security/api';
import { announceBinary } from './_helpers/binary-availability';
import { writeSecretFixture } from './_helpers/synthetic-workload';

describe('gitleaks contract', () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await announceBinary('gitleaks');
    if (available) {
      const fix = await writeSecretFixture();
      dir = fix.dir;
    }
  });

  afterAll(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects the fake AWS-shaped secret in the fixture', async () => {
    if (!available) {
      console.log('[contract] gitleaks: skipping (binary unavailable)');
      return;
    }
    const adapter = new SecretsScannerAdapter({
      realScannersFlag: () => true,
      runner: new NodeSubprocessRunner(),
      timeoutMs: 60_000,
      sourcePath: dir,
    });
    const findings = await adapter.scan({ records: [] });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.evidence.source).toBe('gitleaks');
  });
});
