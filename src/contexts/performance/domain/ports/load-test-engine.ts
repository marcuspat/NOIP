// LoadTestEngine port — domain-side interface that the autocannon and
// k6 infrastructure adapters implement. The application service picks
// an engine by `engine` name (e.g. 'autocannon', 'k6') and dispatches
// to the registered adapter.

import type { LoadTestSummary, Profile } from '../value-objects';

export interface LoadTestRunRequest {
  /** Bench script — k6 JS or an autocannon scenario JSON blob. */
  script: string;
  /** Target URL. */
  target: string;
  profile: Profile;
}

export interface LoadTestEngine {
  /** Stable string used to select the engine in the application service. */
  readonly id: string;
  /**
   * Execute the load test and return a normalized summary. May throw
   * `NotConfiguredError` (when the engine's CLI/dependency is missing),
   * `ProviderError` (when the engine ran but failed), or
   * `ValidationError` (when the script is malformed).
   */
  run(req: LoadTestRunRequest): Promise<LoadTestSummary>;
}
