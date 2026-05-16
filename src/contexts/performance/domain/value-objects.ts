// Value objects for the Performance context (DDD-09).
//
// Pure data shapes. Aggregates and application services compose these.
// `ProbeKind`, `Schedule`, `Profile`, `LoadTestStatus`, `Window`,
// `SLOTarget`, `Indicator`, and `LoadTestSummary` are the public-language
// per DDD-09.

import type { SLOId } from '../../../shared/kernel';

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export type ProbeKind = 'http' | 'tcp' | 'dns' | 'grpc';

export interface Schedule {
  /** Run interval in milliseconds. Must be > 0. */
  intervalMs: number;
  /** Optional probe timeout (per attempt). Defaults to 5_000 ms when absent. */
  timeoutMs?: number;
}

export interface HttpProbeConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  /** Optional substring/regex the body must match. */
  bodyMatcher?: string;
}

export type ProbeConfig =
  | (HttpProbeConfig & { kind?: 'http' })
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Probe results
// ---------------------------------------------------------------------------

export interface ProbeMeasurements {
  /** Optional DNS lookup time (ms). */
  dnsMs?: number;
  /** Optional connection establishment time (ms). */
  connectMs?: number;
  /** Optional TTFB (ms). */
  ttfbMs?: number;
  /** Optional response size in bytes. */
  bytes?: number;
  /** Optional status code on HTTP/gRPC probes. */
  statusCode?: number;
}

// ---------------------------------------------------------------------------
// Load tests
// ---------------------------------------------------------------------------

export type LoadTestStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Profile {
  /** Steady-state RPS target. */
  rps: number;
  /** Virtual users; engines that don't model VUs may ignore. */
  vus: number;
  /** Duration in seconds. Must be > 0. */
  durationSec: number;
  /** Optional warm-up ramp in seconds. */
  rampUpSec?: number;
}

export interface LoadTestSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number; // 0..1
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Raw bench output, if the engine returned a JSON blob. */
  raw?: Record<string, unknown>;
}

export function emptyLoadTestSummary(): LoadTestSummary {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    errorRate: 0,
    rps: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
  };
}

export interface LoadTestError {
  code:
    | 'PROVIDER_ERROR'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR'
    | 'VALIDATION_ERROR'
    | 'NOT_CONFIGURED';
  message: string;
}

// ---------------------------------------------------------------------------
// SLOs
// ---------------------------------------------------------------------------

export interface Window {
  /** Rolling window in days, e.g. 28. */
  rollingDays: number;
}

/**
 * Numeric target the SLO is measured against. `kind` decides whether
 * the indicator value must stay <= or >= `value`. We codify the two
 * common variants: availability (>= 0.999) and latency (<= 200ms).
 */
export interface SLOTarget {
  kind: 'availability' | 'latency_ms' | 'error_rate';
  /** Target threshold in the unit implied by `kind`. */
  value: number;
}

/**
 * Indicator points at a metric in the metrics store. For Prometheus the
 * `query` is a PromQL expression; alternative stores must understand the
 * same string or ignore it.
 */
export interface Indicator {
  query: string;
  /** Optional human-readable label for dashboards. */
  label?: string;
}

/** Snapshot returned from the public API for dashboards. */
export interface SLOSnapshot {
  sloId: SLOId;
  name: string;
  target: SLOTarget;
  window: Window;
  currentBurnRate: number;
  remainingBudget: number;
  computedAt: string;
}
