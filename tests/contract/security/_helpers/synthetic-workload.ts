// Canned fixtures used by contract tests when invoking real scanners.

import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScannerInput } from '../../../../src/contexts/security/domain/ports/scanner-client';

/**
 * Known vulnerable image used by the Trivy contract test. alpine:3.10
 * has a stable set of CVEs that Trivy reports as CRITICAL.
 */
export const VULNERABLE_IMAGE = 'alpine:3.10';

/** A Pod manifest with multiple anti-patterns kube-linter will flag. */
export const BAD_POD_MANIFEST = `apiVersion: v1
kind: Pod
metadata:
  name: bad
  namespace: demo
spec:
  hostNetwork: true
  containers:
    - name: app
      image: nginx:latest
      securityContext:
        privileged: true
`;

/** Generates a snapshot input shaped like the Discovery context produces. */
export function syntheticInput(): ScannerInput {
  return {
    records: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        namespace: 'demo',
        name: 'bad',
        labels: {},
        annotations: {},
        spec: {
          hostNetwork: true,
          containers: [
            {
              name: 'app',
              image: 'nginx:latest',
              securityContext: { privileged: true },
            },
          ],
        },
        status: {},
      },
    ],
  };
}

/**
 * Write a file containing a fake-but-secret-shaped string into a temp
 * dir and return both the dir and the file path. Used by the secrets
 * scanner contract test against gitleaks.
 */
export async function writeSecretFixture(): Promise<{
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'noip-security-secret-'));
  const file = join(dir, 'leak.yaml');
  // Fake-looking AWS access key. Gitleaks fires on this shape.
  const body =
    'api_credentials:\n' +
    '  aws_access_key_id: AKIAIOSFODNN7EXAMPLE\n' +
    '  aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';
  await writeFile(file, body, 'utf8');
  return { dir, file };
}

/** Write a deliberately-bad pod fixture for the kube-linter contract test. */
export async function writeBadPodFixture(): Promise<{
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'noip-security-klint-'));
  const file = join(dir, 'pod.yaml');
  await writeFile(file, BAD_POD_MANIFEST, 'utf8');
  return { dir, file };
}
