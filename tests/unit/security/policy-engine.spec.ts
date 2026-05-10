// BuiltinPolicyScanner — policy-by-policy coverage.

import {
  BuiltinPolicyScanner,
  builtinPolicyId,
} from '../../../src/contexts/security/infrastructure/scanners/builtin-policy-scanner';
import { FixedClock } from '../../../src/shared/kernel';

const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));
const scanner = new BuiltinPolicyScanner(clock, { concurrency: 4 });

function pod(spec: unknown, name = 'p1', namespace = 'default') {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    name,
    namespace,
    labels: {},
    annotations: {},
    spec,
    status: {},
  };
}

describe('BuiltinPolicyScanner', () => {
  it('detects privileged containers', async () => {
    const records = [
      pod({
        containers: [
          { name: 'c', image: 'foo:1', securityContext: { privileged: true } },
        ],
      }),
    ];
    const findings = await scanner.scan({ records });
    const privileged = findings.find(
      f => f.policyId === builtinPolicyId('k8s.privileged')
    );
    expect(privileged).toBeDefined();
    expect(privileged!.severity).toBe('critical');
  });

  it('detects runAsRoot when neither pod nor container declare runAsNonRoot', async () => {
    const records = [
      pod({
        containers: [{ name: 'c', image: 'nginx:1.25', readinessProbe: {} }],
      }),
    ];
    const findings = await scanner.scan({ records });
    const root = findings.find(
      f => f.policyId === builtinPolicyId('k8s.runAsRoot')
    );
    expect(root).toBeDefined();
    expect(root!.severity).toBe('high');
  });

  it('does NOT flag runAsRoot when securityContext.runAsNonRoot=true', async () => {
    const records = [
      pod({
        securityContext: { runAsNonRoot: true },
        containers: [
          {
            name: 'c',
            image: 'nginx:1.25',
            resources: { limits: { memory: '256Mi' } },
            readinessProbe: {},
          },
        ],
      }),
    ];
    const findings = await scanner.scan({ records });
    const root = findings.find(
      f => f.policyId === builtinPolicyId('k8s.runAsRoot')
    );
    expect(root).toBeUndefined();
  });

  it('detects hostNetwork=true', async () => {
    const records = [
      pod({
        hostNetwork: true,
        containers: [{ name: 'c', image: 'nginx:1.25' }],
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(f => f.policyId === builtinPolicyId('k8s.hostNetwork'))
    ).toBe(true);
  });

  it('detects secret-in-env via name heuristic', async () => {
    const records = [
      pod({
        containers: [
          {
            name: 'c',
            image: 'nginx:1.25',
            env: [{ name: 'API_KEY', value: 'sk_live_abcdef1234' }],
          },
        ],
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(f => f.policyId === builtinPolicyId('k8s.secretInEnv'))
    ).toBe(true);
  });

  it('does NOT flag secrets when secretKeyRef is used', async () => {
    const records = [
      pod({
        containers: [
          {
            name: 'c',
            image: 'nginx:1.25',
            env: [
              {
                name: 'API_KEY',
                valueFrom: { secretKeyRef: { name: 's', key: 'k' } },
              },
            ],
          },
        ],
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(f => f.policyId === builtinPolicyId('k8s.secretInEnv'))
    ).toBe(false);
  });

  it('detects latest image tag', async () => {
    const records = [
      pod({
        containers: [{ name: 'c', image: 'nginx:latest' }],
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(f => f.policyId === builtinPolicyId('k8s.latestImageTag'))
    ).toBe(true);
  });

  it('detects missing readiness/liveness probes', async () => {
    const records = [
      pod({
        containers: [
          {
            name: 'c',
            image: 'nginx:1.25',
            resources: { limits: { memory: '256Mi' } },
          },
        ],
        securityContext: { runAsNonRoot: true },
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(f => f.policyId === builtinPolicyId('k8s.missingProbes'))
    ).toBe(true);
  });

  it('detects missing memory limits', async () => {
    const records = [
      pod({
        containers: [{ name: 'c', image: 'nginx:1.25' }],
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(
        f => f.policyId === builtinPolicyId('k8s.missingResourceLimits')
      )
    ).toBe(true);
  });

  it('detects namespaces missing a NetworkPolicy', async () => {
    const records = [
      pod({
        containers: [
          {
            name: 'c',
            image: 'nginx:1.25',
            resources: { limits: { memory: '256Mi' } },
            readinessProbe: {},
          },
        ],
        securityContext: { runAsNonRoot: true },
      }),
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(
        f => f.policyId === builtinPolicyId('k8s.missingNetworkPolicy')
      )
    ).toBe(true);
  });

  it('does NOT flag missing NetworkPolicy when one exists in the namespace', async () => {
    const records = [
      pod(
        {
          containers: [
            {
              name: 'c',
              image: 'nginx:1.25',
              resources: { limits: { memory: '256Mi' } },
              readinessProbe: {},
            },
          ],
          securityContext: { runAsNonRoot: true },
        },
        'p1',
        'app'
      ),
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        name: 'allow-all',
        namespace: 'app',
        labels: {},
        annotations: {},
        spec: { podSelector: { matchLabels: {} } },
        status: {},
      },
    ];
    const findings = await scanner.scan({ records });
    expect(
      findings.some(
        f => f.policyId === builtinPolicyId('k8s.missingNetworkPolicy')
      )
    ).toBe(false);
  });
});
