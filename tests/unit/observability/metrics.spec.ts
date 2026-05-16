// Tests for src/observability/metrics.ts — ADR-0023.
//
// Confirms each typed metric defined in metrics.ts:
//   * Has the expected name (matches the ADR).
//   * Carries the documented label set.
//   * Has a non-empty help string.
//
// Tests interrogate the live prom-client metric via the shared
// registry. We import `metrics` once (it self-registers on first
// import) and inspect the resulting metric objects.

import { register } from '../../../src/observability/registry';
// Side-effect import: registers every typed metric on `register`.
import * as metrics from '../../../src/observability/metrics';

describe('observability/metrics — typed metric definitions', () => {
  type LabelSpec = { name: string; labels: string[]; helpContains?: string };

  const expectations: LabelSpec[] = [
    {
      name: 'noip_http_requests_total',
      labels: ['method', 'route', 'status'],
      helpContains: 'HTTP requests',
    },
    {
      name: 'noip_http_request_duration_seconds',
      labels: ['route'],
      helpContains: 'latency',
    },
    {
      name: 'noip_auth_login_attempts_total',
      labels: ['result'],
      helpContains: 'Login attempts',
    },
    {
      name: 'noip_mfa_verification_attempts_total',
      labels: ['result'],
      helpContains: 'Multi-factor',
    },
    {
      name: 'noip_ai_requests_total',
      labels: ['type', 'result'],
      helpContains: 'AI',
    },
    {
      name: 'noip_ai_request_tokens_total',
      labels: ['type', 'direction'],
      helpContains: 'tokens',
    },
    {
      name: 'noip_rate_limit_blocks_total',
      labels: ['bucket'],
      helpContains: 'rate limiter',
    },
    {
      name: 'noip_security_findings_total',
      labels: ['severity'],
      helpContains: 'Security findings',
    },
    {
      name: 'noip_jobs_processed_total',
      labels: ['job'],
      helpContains: 'Background jobs',
    },
    {
      name: 'noip_jobs_processed_failed_total',
      labels: ['job'],
      helpContains: 'failed',
    },
    {
      name: 'noip_kubernetes_requests_total',
      labels: ['verb', 'status'],
      helpContains: 'kube-apiserver',
    },
    {
      name: 'noip_audit_persist_failed_total',
      labels: [],
      helpContains: 'persist',
    },
    {
      name: 'noip_authz_checks_total',
      labels: ['decision', 'resource', 'action'],
      helpContains: 'Authorisation',
    },
  ];

  it.each(expectations)(
    'defines $name with the documented labels and help text',
    ({ name, labels, helpContains }) => {
      const m = register.getSingleMetric(name);
      expect(m).toBeDefined();

      const labelNames = (m as unknown as { labelNames: string[] }).labelNames;
      expect(labelNames).toEqual(labels);

      const help = (m as unknown as { help: string }).help;
      expect(help).toBeTruthy();
      if (helpContains) {
        expect(help).toContain(helpContains);
      }
    }
  );

  it('exports a typed const for every documented metric', () => {
    expect(metrics.httpRequestsTotal).toBeDefined();
    expect(metrics.httpRequestDurationSeconds).toBeDefined();
    expect(metrics.authLoginAttemptsTotal).toBeDefined();
    expect(metrics.mfaVerificationAttemptsTotal).toBeDefined();
    expect(metrics.aiRequestsTotal).toBeDefined();
    expect(metrics.aiRequestTokensTotal).toBeDefined();
    expect(metrics.rateLimitBlocksTotal).toBeDefined();
    expect(metrics.securityFindingsTotal).toBeDefined();
    expect(metrics.jobsProcessedTotal).toBeDefined();
    expect(metrics.jobsProcessedFailedTotal).toBeDefined();
    expect(metrics.kubernetesRequestsTotal).toBeDefined();
    expect(metrics.auditPersistFailedTotal).toBeDefined();
    expect(metrics.authzChecksTotal).toBeDefined();
  });
});
