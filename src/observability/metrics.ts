// Centralised typed Prometheus metric definitions for NOIP (ADR-0023).
//
// Every metric below auto-registers against the shared registry on
// module import (see `registry.ts`). Call sites import the named
// constant and use `.inc()` / `.observe()` directly:
//
//   import { httpRequestsTotal } from '../observability/metrics';
//   httpRequestsTotal.labels({ method, route, status }).inc();
//
// Naming follows the ADR — keep the `noip_` prefix and existing
// units suffixes (`_total`, `_seconds`) so dashboards do not break.

import { counter, histogram } from './registry';

// ---------------------------------------------------------------------------
// HTTP layer (mounted via http-metrics.middleware.ts)
// ---------------------------------------------------------------------------

/** All inbound HTTP requests, labelled with the parameterised route. */
export const httpRequestsTotal = counter(
  'noip_http_requests_total',
  'Total HTTP requests handled by the NOIP API, labelled by method, route, and HTTP status.',
  ['method', 'route', 'status'] as const
);

/** End-to-end latency for inbound requests, observed on `res.finish`. */
export const httpRequestDurationSeconds = histogram(
  'noip_http_request_duration_seconds',
  'End-to-end HTTP request latency in seconds, observed on response finish, labelled by route.',
  ['route'] as const
);

// ---------------------------------------------------------------------------
// Authentication & MFA
// ---------------------------------------------------------------------------

/** Login attempts labelled by terminal outcome (success | failure | locked). */
export const authLoginAttemptsTotal = counter(
  'noip_auth_login_attempts_total',
  'Login attempts grouped by terminal result (success | failure | locked).',
  ['result'] as const
);

/** MFA verifications labelled by terminal outcome (success | failure). */
export const mfaVerificationAttemptsTotal = counter(
  'noip_mfa_verification_attempts_total',
  'Multi-factor authentication verification attempts grouped by result (success | failure).',
  ['result'] as const
);

// ---------------------------------------------------------------------------
// AI / LLM cost & success tracking
// ---------------------------------------------------------------------------

/** AI requests grouped by request type and terminal result. */
export const aiRequestsTotal = counter(
  'noip_ai_requests_total',
  'AI / LLM outbound requests grouped by request type and terminal result (success | error).',
  ['type', 'result'] as const
);

/**
 * Token usage broken out by `type` (input | output | cache_read |
 * cache_write) and `direction` (request | response). Increments by
 * token count so this is a true sum, not a request count.
 */
export const aiRequestTokensTotal = counter(
  'noip_ai_request_tokens_total',
  'AI / LLM tokens consumed, grouped by token type and direction. Increments by token count.',
  ['type', 'direction'] as const
);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** 429 emissions grouped by ADR-0016 bucket. */
export const rateLimitBlocksTotal = counter(
  'noip_rate_limit_blocks_total',
  'HTTP requests rejected with 429 by the rate limiter, grouped by ADR-0016 bucket.',
  ['bucket'] as const
);

// ---------------------------------------------------------------------------
// Security findings
// ---------------------------------------------------------------------------

/**
 * Findings persisted by the security scanner, grouped by severity.
 * Increments by the count of new findings opened in a scan.
 */
export const securityFindingsTotal = counter(
  'noip_security_findings_total',
  'Security findings persisted by the scanner, grouped by severity. Increments by count of newly opened findings.',
  ['severity'] as const
);

// ---------------------------------------------------------------------------
// Background jobs (scan scheduler, AI orchestrator, etc.)
// ---------------------------------------------------------------------------

/** Successful background-job runs, labelled by job name. */
export const jobsProcessedTotal = counter(
  'noip_jobs_processed_total',
  'Background jobs that completed successfully, labelled by job name.',
  ['job'] as const
);

/** Failed background-job runs, labelled by job name. */
export const jobsProcessedFailedTotal = counter(
  'noip_jobs_processed_failed_total',
  'Background jobs that failed, labelled by job name.',
  ['job'] as const
);

// ---------------------------------------------------------------------------
// Kubernetes adapter (DDD-06 ACL)
// ---------------------------------------------------------------------------

/** Kube-apiserver requests issued by the discovery adapter. */
export const kubernetesRequestsTotal = counter(
  'noip_kubernetes_requests_total',
  'kube-apiserver requests issued by the discovery adapter, labelled by verb and result status.',
  ['verb', 'status'] as const
);

// ---------------------------------------------------------------------------
// Audit pipeline
// ---------------------------------------------------------------------------

/** Audit entries the appender failed to persist (Mongo outage, etc.). */
export const auditPersistFailedTotal = counter(
  'noip_audit_persist_failed_total',
  'Audit entries that the hash-chain appender failed to persist.'
);

/** Audit DomainEvents the middleware failed to publish onto the bus. */
export const auditPublishFailedTotal = counter(
  'noip_audit_publish_failed_total',
  'Audit DomainEvents that the audit middleware failed to publish to the EventBus.'
);

// ---------------------------------------------------------------------------
// Authorisation checks (ADR-0008)
// ---------------------------------------------------------------------------

/**
 * Authorisation decisions made by `requirePermission`. `decision` is
 * `allow` or `deny`; `resource`/`action` carry the gate identity so
 * dashboards can break down deny rates per route.
 */
export const authzChecksTotal = counter(
  'noip_authz_checks_total',
  'Authorisation decisions emitted by requirePermission, labelled by decision, resource, and action.',
  ['decision', 'resource', 'action'] as const
);
