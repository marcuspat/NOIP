// Barrel for the observability layer (ADR-0023). Keep this file
// import-free of any side-effects beyond the metric registrations in
// `./metrics` — composition roots should be able to `import * as obs`
// and discover everything they need from one symbol.

export {
  register,
  counter,
  gauge,
  histogram,
  collectNodeDefaultMetrics,
  resetRegistryForTests,
  DEFAULT_HISTOGRAM_BUCKETS,
} from './registry';

export * as metrics from './metrics';

export {
  httpMetricsMiddleware,
  resolveRouteLabel,
} from './http-metrics.middleware';

export { metricsEndpoint } from './metrics-endpoint';
